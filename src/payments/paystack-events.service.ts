import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyGatewayTransfer,
  type TransferOutcome,
} from './domain/payout-rules';
import { classifyGatewayRefund } from './domain/refund-rules';
import { verifyPaystackSignature } from './domain/webhook-signature';
import {
  GatewayInboxService,
  type EventOutcome,
  type InboundEvent,
} from './gateway-inbox.service';
import type { PaymentGateway } from './payment-gateway';
import { FinanceService } from './finance.service';
import { PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Refund events that carry a final state. `refund.pending` and `refund.processing` change nothing here. */
const REFUND_EVENTS = {
  'refund.processed': 'processed',
  'refund.failed': 'failed',
  'refund.needs-attention': 'failed',
} as const;

const TRANSFER_EVENTS = [
  'transfer.success',
  'transfer.failed',
  'transfer.reversed',
];

/** Receives signed Paystack events and runs them through the gateway inbox (05 §6.2, §8). */
@Injectable()
export class PaystackEventsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly inbox: GatewayInboxService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly finance: FinanceService,
    private readonly registry: TimerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.registerSweeper(async (now) => {
      await this.inbox.sweep((event) => this.process(event), now);
    });
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    return verifyPaystackSignature(
      this.config.get<string>('PAYSTACK_SECRET_KEY'),
      rawBody,
      signature,
    );
  }

  /** The signature is checked on the raw bytes first; every field then comes from those same bytes, never from `req.body`. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.verifySignature(rawBody, signature))
      throw new UnauthorizedException('Invalid Paystack signature.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // new message: not in spec
      throw new BadRequestException('The webhook body is not valid JSON.');
    }
    const payload = asRecord(parsed);
    const data = asRecord(payload.data);
    const digest = createHash('sha256').update(rawBody).digest('hex');
    return this.inbox.receive(
      {
        fingerprint: digest,
        rawBodyDigest: digest,
        event: typeof payload.event === 'string' ? payload.event : 'unknown',
        // A refund event names the charged transaction as `transaction_reference`.
        reference:
          typeof data.reference === 'string'
            ? data.reference
            : typeof data.transaction_reference === 'string'
              ? data.transaction_reference
              : null,
        subjectId:
          typeof data.id === 'string' || typeof data.id === 'number'
            ? String(data.id)
            : null,
      },
      (event) => this.process(event),
    );
  }

  /** Does the work for one stored event. Throws when it should be retried. */
  async process(event: InboundEvent): Promise<EventOutcome> {
    if (Object.hasOwn(REFUND_EVENTS, event.event))
      return this.refundSettled(
        event,
        REFUND_EVENTS[event.event as keyof typeof REFUND_EVENTS],
      );
    if (TRANSFER_EVENTS.includes(event.event) && event.reference)
      return this.transferSettled(event, event.reference);
    if (event.event === 'charge.success' && event.reference)
      return this.chargeSuccess(event, event.reference);
    return { status: 'ignored' };
  }

  private async chargeSuccess(
    event: InboundEvent,
    reference: string,
  ): Promise<EventOutcome> {
    const verified = await this.gateway.verify(reference);
    const payment = await this.prisma.payment.findUnique({
      where: { reference },
    });
    if (!payment) {
      if (verified.status !== 'success')
        return { status: 'ignored', reason: 'No matching payment.' };
      // Money was collected under a reference we never issued.
      const reason = 'No XPro payment has this reference.';
      await this.payments.quarantine(
        { payment: null, reference, reason },
        (tx) =>
          this.inbox.markDone(tx, event.fingerprint, {
            status: 'quarantined',
            reason,
          }),
      );
      return { status: 'quarantined', reason };
    }
    if (verified.status !== 'success')
      return {
        status: 'ignored',
        reason: 'The verified transaction was not successful.',
      };
    const match = await this.payments.matchOrQuarantine(
      payment,
      verified,
      (tx) =>
        this.inbox.markDone(tx, event.fingerprint, {
          status: 'quarantined',
          reason: 'Verified transaction did not match the payment record.',
        }),
    );
    if (!match.matches)
      return {
        status: 'quarantined',
        reason: match.reason,
      };
    const result = await this.payments.settleCharge(payment, verified, {
      source: 'webhook',
      onSettled: (tx) =>
        this.inbox.markDone(tx, event.fingerprint, { status: 'processed' }),
    });
    return { status: 'processed', duplicate: !result.claimed };
  }

  /**
   * `refund.processed`, `refund.failed` and `refund.needs-attention` (05 §6.4,
   * §8). The event only says which refund to look at: its state is verified
   * with Paystack, and the refund, payment status, cancellation resolution and
   * inbox row then change in one transaction (see `RefundsService`).
   */
  private async refundSettled(
    event: InboundEvent,
    expected: 'processed' | 'failed',
  ): Promise<EventOutcome> {
    const refundId = event.subjectId ?? '';
    const refund = refundId ? await this.findRefund(refundId, event) : null;
    const verified = refund ? await this.gateway.verifyRefund(refundId) : null;
    if (
      !refund ||
      !verified ||
      classifyGatewayRefund(verified.status) !== expected ||
      (verified.amount != null && verified.amount !== Number(refund.amount))
    )
      return {
        status: 'ignored',
        reason:
          'Refund status could not be verified against an approved refund.',
      };
    const { applied } = await this.refunds.settleFromGateway(
      refund.id,
      { ...verified, id: refundId },
      {
        actor: null,
        onSettled: (tx) =>
          this.inbox.markDone(tx, event.fingerprint, { status: 'processed' }),
      },
    );
    return { status: 'processed', duplicate: !applied };
  }

  /** The refund Paystack means: the one holding its gateway id or, if our record of the submission was lost, the unclaimed in-flight refund on that transaction. */
  private async findRefund(refundId: string, event: InboundEvent) {
    const byId = await this.prisma.refund.findFirst({
      where: { gatewayRefundId: refundId },
    });
    if (byId || !event.reference) return byId;
    return this.prisma.refund.findFirst({
      where: {
        status: 'processing',
        gatewayRefundId: null,
        payment: { reference: event.reference },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * `transfer.success`, `transfer.failed` and `transfer.reversed` (05 §6.5,
   * §8). The event only names the transfer: its state is verified with
   * Paystack, and the attempt, the payout (latest attempt and matching amount
   * only), the notifications and the inbox row then change in one transaction
   * (see `FinanceService`).
   */
  private async transferSettled(
    event: InboundEvent,
    reference: string,
  ): Promise<EventOutcome> {
    const attempt = await this.prisma.transferAttempt.findUnique({
      where: { reference },
      select: { id: true },
    });
    const verified = attempt
      ? await this.gateway.verifyTransfer(reference)
      : null;
    const expectedStatus: TransferOutcome =
      event.event === 'transfer.success'
        ? 'success'
        : event.event === 'transfer.reversed'
          ? 'reversed'
          : 'failed';
    if (
      !attempt ||
      !verified ||
      verified.reference !== reference ||
      classifyGatewayTransfer(verified.status) !== expectedStatus
    )
      return {
        status: 'ignored',
        reason: 'Transfer status could not be verified.',
      };
    const { applied } = await this.finance.settleTransferFromGateway(
      reference,
      expectedStatus,
      {
        actor: null,
        verifiedAmount: verified.amount,
        onSettled: (tx) =>
          this.inbox.markDone(tx, event.fingerprint, { status: 'processed' }),
      },
    );
    return { status: 'processed', duplicate: !applied };
  }
}
