import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Payment, Prisma } from '@prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import {
  IDEMPOTENCY_TTL_MS,
  IdempotencyService,
  hashRequest,
} from '../platform/idempotency/idempotency.service';
import {
  RequestCommandRunner,
  type CommandContext,
} from '../requests/command-runner';
import { RequestEventsService } from '../requests/events/request-events.service';
import { formatRequestId } from '../requests/domain/statuses';
import { resolveRequestId } from '../requests/request-ref';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import type { RequestUser } from '../common/types/request-user';
import { amountDue } from './domain/amount-due';
import {
  PENDING_ATTEMPT_WINDOW_MS,
  pendingCheckDueAt,
} from './domain/pending-attempt';
import { REFUND_MESSAGES, refundableBalance } from './domain/refund-rules';
import { compareTransaction } from './domain/transaction-match';
import type { PaymentGateway, VerifiedTransaction } from './payment-gateway';
import { toPaymentDto } from './payment.projection';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export const NOT_AWAITING_PAYMENT = 'This quote is no longer awaiting payment.';
export const PAYMENT_IN_PROGRESS =
  'A payment is already in progress. Check its status before trying again.';
export const AMOUNT_MISMATCH = 'The payment amount must match the amount due.';
export const SAME_ACTOR_RECONCILE =
  'Another staff member must reconcile this payment.';
const NOT_AWAITING_RECONCILIATION =
  'This payment is not awaiting reconciliation.';
// new message: not in spec
const REFERENCE_USED = 'This payment reference has already been used.';
// new message: not in spec
const FUTURE_PAID_AT = 'The payment date cannot be in the future.';

/** Paystack statuses that confirm no charge happened (05 §8: release the attempt only then). */
const NO_CHARGE_STATUSES = new Set(['failed', 'abandoned']);

const notFound = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This request is no longer available to your account.',
  );
const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const validation = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);

type InitiateResponse = {
  paymentId: string;
  authorizationUrl: string;
  reference: string;
};
type StoredInitiate = Partial<InitiateResponse> & { inFlight?: boolean };

export type RecheckResult = 'settled' | 'failed' | 'pending' | 'quarantined';

type QuarantineInput = {
  payment: {
    id: string;
    requestId: string;
    reference: string;
    quoteId: string;
  } | null;
  reference: string;
  reason: string;
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly idempotency: IdempotencyService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly uploads: UploadsService,
    private readonly requestEvents: RequestEventsService,
    private readonly runner: RequestCommandRunner,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /**
   * 05 §6.4: opens the pending refund for the full refundable balance of every
   * settled payment (`paid` or `partially_refunded`) on a request whose
   * cancellation was approved. Each payment row is locked, so a concurrent
   * refund cannot also take the balance. The `refund` approval item opens and
   * Finance is told, in the caller's transaction (plan C.4, C.5).
   */
  async openForCancellation(
    ctx: CommandContext,
    input: {
      cancellationId: string;
      requestedBy: string;
      workStarted: boolean;
    },
  ) {
    const settled = await ctx.tx.payment.findMany({
      where: {
        requestId: ctx.snap.id,
        status: { in: ['paid', 'partially_refunded'] },
      },
      orderBy: { paidAt: 'desc' },
      select: { id: true },
    });
    if (!settled.length)
      throw conflict('A settled payment is required before opening a refund.');
    const opened: Array<{ id: string; amount: bigint }> = [];
    for (const { id } of settled) {
      await ctx.tx.$queryRaw(
        Prisma.sql`SELECT id FROM payments WHERE id = ${id} FOR UPDATE`,
      );
      const payment = await ctx.tx.payment.findUniqueOrThrow({ where: { id } });
      const balance = refundableBalance(
        payment.amount,
        await ctx.tx.refund.findMany({
          where: { paymentId: id },
          select: { amount: true, status: true },
        }),
      );
      if (balance <= 0n) continue;
      const refund = await ctx.tx.refund.create({
        data: {
          paymentId: id,
          requestId: ctx.snap.id,
          cancellationId: input.cancellationId,
          amount: balance,
          status: 'pending_approval',
          reason: input.workStarted
            ? 'Cancellation after work started; refund amount requires review.'
            : 'Cancellation refund review.',
          requestedBy: input.requestedBy,
        },
      });
      ctx.audit('Refund opened for cancellation', {
        resourceType: 'refund',
        resourceId: refund.id,
        changes: {
          paymentId: id,
          cancellationId: input.cancellationId,
          amount: Number(balance),
          workStarted: input.workStarted,
        },
      });
      ctx.approvals.open('refund', refund.id);
      ctx.notify('refund.requested', {
        requestCode: ctx.snap.number,
        amount: Number(balance),
      });
      opened.push({ id: refund.id, amount: balance });
    }
    if (!opened.length) throw conflict(REFUND_MESSAGES.nothingLeft);
    return opened;
  }

  async getRequestPayments(user: RequestUser, ref: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findRequest(ref);
    const isStaff = actor.kind === 'staff';
    if (!isStaff && request.ownerId !== user.id) throw notFound();
    if (isStaff && actor.staff?.status !== 'active') throw notFound();
    const [quote, rows, refunds] = await Promise.all([
      this.prisma.quote.findFirst({
        where: { requestId: request.id, status: 'accepted' },
        orderBy: { version: 'desc' },
      }),
      this.prisma.payment.findMany({
        where: { requestId: request.id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.refund.findMany({
        where: { requestId: request.id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const canViewAmount =
      !isStaff || actor.staff?.permissions.has('view.pricing') === true;
    const completedRefunds = refunds
      .filter((refund) => refund.status === 'completed')
      .reduce((sum, refund) => sum + refund.amount, 0n);
    return {
      amountDue:
        canViewAmount && quote
          ? Number(amountDue(quote.total, rows, completedRefunds))
          : null,
      dueAt: quote?.paymentDueAt ?? null,
      offlineInstructions:
        (
          await this.prisma.setting.findUnique({
            where: { key: 'payment.offlineInstructions' },
            select: { value: true },
          })
        )?.value ?? null,
      // Staff without view.pricing see status flags only: no figures, references or channels (05 §10).
      payments: rows.map((row) =>
        canViewAmount
          ? {
              id: row.id,
              amount: Number(row.amount),
              method: row.method,
              status: row.status,
              reference: row.reference,
              channel: row.channel,
              paidAt: row.paidAt,
              createdAt: row.createdAt,
            }
          : {
              id: row.id,
              amount: null,
              method: row.method,
              status: row.status,
              paidAt: row.paidAt,
              createdAt: row.createdAt,
            },
      ),
      refunds: refunds.map((row) => ({
        id: row.id,
        amount: canViewAmount ? Number(row.amount) : null,
        status: row.status,
        reason: canViewAmount ? row.reason : null,
      })),
    };
  }

  async initiate(
    user: RequestUser,
    ref: string,
    key: string,
    url: string,
  ): Promise<InitiateResponse> {
    const requestHash = hashRequest('POST', url, { method: 'paystack' });
    const replay = await this.idempotency.lookup(user.id, key, requestHash);
    if (replay) {
      const stored = replay.body as StoredInitiate;
      if (stored.inFlight)
        throw new AppError(409, 'PAYMENT_IN_PROGRESS', PAYMENT_IN_PROGRESS);
      return stored as InitiateResponse;
    }
    const actor = await this.actors.resolve(user.id);
    const attempt: {
      requestId?: string;
      quoteId?: string;
      paymentId?: string;
      reference?: string;
      email?: string;
      amount?: number;
    } = {};
    // 05 §6.1: the pending row, its 30-minute check and the idempotency reservation commit before Paystack is called.
    await this.runner.run(
      {
        command: 'payment.initiate',
        actor,
        requestRef: ref,
        input: { method: 'paystack' },
      },
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        if (!quote) throw conflict(NOT_AWAITING_PAYMENT);
        const owner = await ctx.tx.user.findUnique({
          where: { id: ctx.snap.ownerId },
          select: { email: true },
        });
        if (!owner?.email)
          throw validation(
            'Add an email address to your account before paying.',
          );
        const reference = `xpro_${randomUUID().replaceAll('-', '')}`;
        const payment = await ctx.tx.payment.create({
          data: {
            requestId: ctx.snap.id,
            quoteId: quote.id,
            quoteVersion: quote.version,
            amount: quote.total,
            method: 'paystack',
            status: 'pending',
            reference,
          },
        });
        ctx.timers.start(
          'payment.pendingCheck',
          pendingCheckDueAt(ctx.now),
          payment.id,
        );
        ctx.audit('Payment initiated', {
          resourceType: 'payment',
          resourceId: payment.id,
          changes: {
            reference,
            amount: Number(quote.total),
            quoteVersion: quote.version,
          },
        });
        await ctx.tx.idempotencyKey.deleteMany({
          where: { actorId: user.id, key, expiresAt: { lte: ctx.now } },
        });
        await ctx.tx.idempotencyKey.createMany({
          data: [
            {
              actorId: user.id,
              key,
              requestHash,
              status: 202,
              response: {
                inFlight: true,
                paymentId: payment.id,
                reference,
              },
              createdAt: ctx.now,
              expiresAt: new Date(
                ctx.now.getTime() + PENDING_ATTEMPT_WINDOW_MS,
              ),
            },
          ],
          skipDuplicates: true,
        });
        Object.assign(attempt, {
          requestId: ctx.snap.id,
          quoteId: quote.id,
          paymentId: payment.id,
          reference,
          email: owner.email,
          amount: Number(quote.total),
        });
        return { bumpVersion: false };
      },
    );
    const { requestId, quoteId, paymentId, reference, email, amount } =
      attempt as {
        requestId: string;
        quoteId: string;
        paymentId: string;
        reference: string;
        email: string;
        amount: number;
      };
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await this.gateway.initialize({
        email,
        amount,
        reference,
        metadata: { requestId, quoteId, paymentId },
      }));
    } catch (error) {
      await this.failInitialization(requestId, paymentId);
      await this.prisma.idempotencyKey.deleteMany({
        where: { actorId: user.id, key, requestHash },
      });
      throw error;
    }
    const response: InitiateResponse = {
      paymentId,
      authorizationUrl,
      reference,
    };
    await this.prisma.idempotencyKey.updateMany({
      where: { actorId: user.id, key, requestHash },
      data: {
        response,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
    return response;
  }

  async recordOffline(
    userId: string,
    ref: string,
    dto: {
      amount: number;
      channel: string;
      reference: string;
      paidAt: string;
      proofFileId?: string;
      note?: string;
    },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payment.record');
    const paymentId = randomUUID();
    const recorded: { row?: Payment } = {};
    try {
      await this.runner.run(
        {
          command: 'payment.recordOffline',
          actor,
          requestRef: ref,
          input: dto,
        },
        async (ctx) => {
          const quote = await ctx.tx.quote.findFirst({
            where: { requestId: ctx.snap.id, status: 'accepted' },
            orderBy: { version: 'desc' },
          });
          if (!quote) throw conflict(NOT_AWAITING_PAYMENT);
          const collected = await ctx.tx.payment.findMany({
            where: { requestId: ctx.snap.id },
            select: { amount: true, status: true },
          });
          if (BigInt(dto.amount) !== amountDue(quote.total, collected))
            throw validation(AMOUNT_MISMATCH);
          const paidAt = new Date(dto.paidAt);
          if (paidAt.getTime() > ctx.now.getTime())
            throw validation(FUTURE_PAID_AT);
          if (
            await ctx.tx.payment.findUnique({
              where: { reference: dto.reference },
              select: { id: true },
            })
          )
            throw conflict(REFERENCE_USED);
          await this.uploads.attach(
            ctx.tx,
            [dto.proofFileId ?? ''],
            userId,
            'payment_proof',
            'payment',
            paymentId,
          );
          recorded.row = await ctx.tx.payment.create({
            data: {
              id: paymentId,
              requestId: ctx.snap.id,
              quoteId: quote.id,
              quoteVersion: quote.version,
              amount: BigInt(dto.amount),
              method: 'offline',
              channel: dto.channel,
              status: 'recorded',
              reference: dto.reference,
              paidAt,
              proofUploadId: dto.proofFileId,
              recordedBy: userId,
              note: dto.note?.trim() || null,
            },
          });
          ctx.audit('Offline payment recorded', {
            resourceType: 'payment',
            resourceId: paymentId,
            note: dto.note?.trim() || undefined,
            changes: {
              reference: dto.reference,
              channel: dto.channel,
              amount: dto.amount,
              proofFileId: dto.proofFileId,
              recordedBy: userId,
            },
          });
          ctx.approvals.open('offline_payment', paymentId);
          ctx.notify('payment.offline_recorded', {
            requestCode: ctx.snap.number,
          });
          return { bumpVersion: false };
        },
      );
    } catch (error) {
      // Another request took the reference between the check and the insert.
      if (isUniqueViolation(error)) throw conflict(REFERENCE_USED);
      throw error;
    }
    return toPaymentDto(recorded.row!);
  }

  async reconcile(userId: string, paymentId: string, note: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payment.record');
    const known = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { requestId: true },
    });
    if (!known) throw conflict(NOT_AWAITING_RECONCILIATION);
    const settled: {
      row?: Payment;
      afterCommit?: () => Promise<void>;
    } = {};
    await this.runner.run(
      {
        command: 'payment.reconcile',
        actor,
        requestRef: known.requestId,
        input: { note },
      },
      async (ctx) => {
        const payment = await ctx.tx.payment.findUnique({
          where: { id: paymentId },
        });
        if (
          !payment ||
          payment.method !== 'offline' ||
          payment.status !== 'recorded'
        )
          throw conflict(NOT_AWAITING_RECONCILIATION);
        // Needs the recorder's id, which the snapshot lacks (05 §6.2, §11: 403 same actor).
        if (payment.recordedBy === userId)
          throw new AppError(403, 'FORBIDDEN', SAME_ACTOR_RECONCILE);
        const quote = await ctx.tx.quote.findUnique({
          where: { id: payment.quoteId },
        });
        if (!quote) throw notFound();
        if (payment.amount !== quote.total) throw validation(AMOUNT_MISMATCH);
        const claimed = await ctx.tx.payment.updateMany({
          where: {
            id: payment.id,
            status: 'recorded',
            recordedBy: { not: userId },
          },
          data: {
            status: 'paid',
            reconciledBy: userId,
            reconciledAt: ctx.now,
            note: `${payment.note ?? ''}${payment.note ? '\n' : ''}${note.trim()}`,
          },
        });
        if (claimed.count !== 1)
          throw conflict('This payment is no longer awaiting reconciliation.');
        // The money was received, so it settles even when the request has lapsed or was cancelled; the late branch opens the full refund (05 §7).
        const events = await this.requestEvents.onPaymentSettled(
          ctx.tx,
          payment.requestId,
          payment.quoteId,
          payment.id,
        );
        settled.afterCommit = events.afterCommit;
        ctx.approvals.close('offline_payment', payment.id, 'reconciled');
        ctx.audit('Offline payment reconciled', {
          resourceType: 'payment',
          resourceId: payment.id,
          note: note.trim(),
          changes: {
            reference: payment.reference,
            recordedBy: payment.recordedBy,
            reconciledBy: userId,
            before: { status: 'recorded' },
            after: { status: 'paid' },
            requestSettled: events.settled,
          },
        });
        settled.row = await ctx.tx.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
        return { bumpVersion: false };
      },
    );
    await settled.afterCommit?.();
    return toPaymentDto(settled.row!);
  }

  async rejectOffline(userId: string, paymentId: string, reason: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payment.record');
    const known = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { requestId: true },
    });
    if (!known) throw conflict(NOT_AWAITING_RECONCILIATION);
    const rejected: { row?: Payment } = {};
    await this.runner.run(
      {
        command: 'payment.rejectOffline',
        actor,
        requestRef: known.requestId,
        input: { reason },
      },
      async (ctx) => {
        const payment = await ctx.tx.payment.findUnique({
          where: { id: paymentId },
        });
        if (
          !payment ||
          payment.method !== 'offline' ||
          payment.status !== 'recorded'
        )
          throw conflict(NOT_AWAITING_RECONCILIATION);
        // 05 §7: the recorder is never the reviewer; same message and 403 as reconcile.
        if (payment.recordedBy === userId)
          throw new AppError(403, 'FORBIDDEN', SAME_ACTOR_RECONCILE);
        const claimed = await ctx.tx.payment.updateMany({
          where: {
            id: payment.id,
            status: 'recorded',
            recordedBy: { not: userId },
          },
          data: {
            status: 'failed',
            failureReason: reason.trim(),
            reconciledBy: userId,
            reconciledAt: ctx.now,
          },
        });
        if (claimed.count !== 1)
          throw conflict('This payment is no longer awaiting reconciliation.');
        ctx.approvals.close('offline_payment', payment.id, 'rejected');
        ctx.audit('Offline payment rejected', {
          resourceType: 'payment',
          resourceId: payment.id,
          note: reason.trim(),
          changes: {
            reference: payment.reference,
            recordedBy: payment.recordedBy,
            reconciledBy: userId,
            before: { status: 'recorded' },
            after: { status: 'failed' },
          },
        });
        rejected.row = await ctx.tx.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
        return { bumpVersion: false };
      },
    );
    return toPaymentDto(rejected.row!);
  }

  /**
   * Asks Paystack what became of a pending attempt (05 §8). A matching success
   * settles it; a mismatch is quarantined; `failed` or `abandoned` releases
   * the attempt once it is 30 minutes old; anything else stays pending.
   */
  async recheckPending(paymentId: string): Promise<RecheckResult | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (
      !payment ||
      payment.status !== 'pending' ||
      payment.method !== 'paystack'
    )
      return null;
    const verified = await this.gateway.verify(payment.reference);
    if (verified.status === 'success') {
      const outcome = await this.matchOrQuarantine(payment, verified);
      if (!outcome.matches) return 'quarantined';
      const result = await this.settleCharge(payment, verified, {
        source: 'recheck',
      });
      return result.claimed ? 'settled' : 'pending';
    }
    const age = Date.now() - payment.createdAt.getTime();
    if (
      NO_CHARGE_STATUSES.has(verified.status) &&
      age >= PENDING_ATTEMPT_WINDOW_MS
    ) {
      await this.failAttempt(
        payment.requestId,
        payment.id,
        'Checkout was not completed.',
        'Payment attempt closed (no charge)',
      );
      return 'failed';
    }
    return 'pending';
  }

  /**
   * 05 §7 and C.4: lock the request, claim `pending -> paid` conditionally,
   * and only then move the request in the same transaction. A claim that
   * matches no row (a duplicate or out-of-order event) has no effect at all.
   * A `failed` Paystack attempt can still be claimed: a verified charge means
   * money arrived, and the late branch refunds it when the request moved on.
   */
  async settleCharge(
    payment: { id: string; requestId: string; quoteId: string; status: string },
    verified: VerifiedTransaction,
    options: {
      source: 'webhook' | 'recheck';
      onSettled?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ): Promise<{ claimed: boolean }> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM service_requests WHERE id = ${payment.requestId} FOR UPDATE`,
        );
        const claimed = await tx.payment.updateMany({
          where: {
            id: payment.id,
            method: 'paystack',
            status: { in: ['pending', 'failed'] },
          },
          data: {
            status: 'paid',
            paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
            gatewayTransactionId:
              verified.id == null ? null : String(verified.id),
            gatewayChannel: verified.channel ?? null,
            failureReason: null,
          },
        });
        if (claimed.count !== 1) {
          await options.onSettled?.(tx);
          return { claimed: false, afterCommit: undefined };
        }
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            entityType: 'payment',
            entityId: payment.id,
            action: 'Payment settled',
            metadata: {
              requestId: payment.requestId,
              reference: verified.reference,
              source: options.source,
              before: { status: payment.status },
              after: { status: 'paid' },
            },
          },
        });
        const events = await this.requestEvents.onPaymentSettled(
          tx,
          payment.requestId,
          payment.quoteId,
          payment.id,
        );
        await options.onSettled?.(tx);
        return { claimed: true, afterCommit: events.afterCommit };
      },
      { timeout: 15_000 },
    );
    await outcome.afterCommit?.();
    return { claimed: outcome.claimed };
  }

  /** The verified transaction, payment and customer email agree, or the money is quarantined for Finance. */
  async matchOrQuarantine(
    payment: {
      id: string;
      requestId: string;
      quoteId: string;
      reference: string;
      amount: bigint;
    },
    verified: VerifiedTransaction,
    inTx?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ matches: boolean; reason?: string }> {
    const result = compareTransaction(
      verified,
      payment,
      await this.getOwnerEmail(payment.requestId),
    );
    if (result.matches) return { matches: true };
    await this.quarantine(
      { payment, reference: payment.reference, reason: result.reason },
      inTx,
    );
    return { matches: false, reason: result.reason };
  }

  /**
   * 05 §7: a verified charge that does not match is never unlocked and never
   * dropped. It is audited and Finance and super admins get a mandatory alert.
   * Repeats for the same payment and reason are not re-alerted.
   */
  async quarantine(
    input: QuarantineInput,
    inTx?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await inTx?.(tx);
      const entityId = input.payment?.id ?? input.reference;
      const action = 'Payment quarantined';
      const alerted = await tx.auditLog.findFirst({
        where: { entityId, action },
        select: { id: true },
      });
      if (alerted) return;
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          entityType: input.payment ? 'payment' : 'gateway_event',
          entityId,
          action,
          metadata: {
            requestId: input.payment?.requestId ?? null,
            reference: input.reference,
            reason: input.reason,
          },
        },
      });
      if (input.payment) {
        const request = await tx.serviceRequest.findUnique({
          where: { id: input.payment.requestId },
          select: { number: true },
        });
        await this.dispatcher.dispatchAlert(tx, 'payment.quarantined', {
          requestCode: formatRequestCode(request?.number),
          reference: input.reference,
          reason: input.reason,
        });
      } else {
        await this.dispatcher.dispatchAlert(
          tx,
          'payment.quarantined_unmatched',
          { reference: input.reference, reason: input.reason },
        );
      }
    });
  }

  async getOwnerEmail(requestId: string): Promise<string | null> {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { ownerId: true },
    });
    if (!request) return null;
    const owner = await this.prisma.user.findUnique({
      where: { id: request.ownerId },
      select: { email: true },
    });
    return owner?.email ?? null;
  }

  private async failInitialization(requestId: string, paymentId: string) {
    await this.failAttempt(
      requestId,
      paymentId,
      'Checkout could not be started.',
      'Payment initialization failed',
    );
  }

  /** `pending -> failed` for an attempt that can no longer be charged. A row that already moved is left alone. */
  private async failAttempt(
    requestId: string,
    paymentId: string,
    failureReason: string,
    action: string,
  ) {
    await this.runner.runSystem(
      'payment.attemptFailed',
      requestId,
      async (ctx) => {
        const claimed = await ctx.tx.payment.updateMany({
          where: { id: paymentId, status: 'pending' },
          data: { status: 'failed', failureReason },
        });
        if (claimed.count !== 1) return { changed: false };
        ctx.timers.stop('payment.pendingCheck', paymentId);
        ctx.audit(action, {
          resourceType: 'payment',
          resourceId: paymentId,
          changes: {
            before: { status: 'pending' },
            after: { status: 'failed' },
          },
        });
        return { bumpVersion: false };
      },
    );
  }

  private async findRequest(ref: string) {
    const id = await resolveRequestId(this.prisma, ref);
    const request = id
      ? await this.prisma.serviceRequest.findUnique({ where: { id } })
      : null;
    if (!request) throw notFound();
    return request;
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

const formatRequestCode = (number: number | undefined) =>
  number === undefined ? 'A request' : formatRequestId(number);
