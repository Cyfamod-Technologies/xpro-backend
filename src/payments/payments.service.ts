import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ActorService } from '../platform/actor/actor.service';
import { requireCustomer, requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { IdempotencyService, hashRequest } from '../platform/idempotency/idempotency.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OutboxService } from '../platform/outbox/outbox.service';
import { TimersService } from '../platform/timers/timers.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import type { RequestUser } from '../common/types/request-user';
import type { PaymentGateway, VerifiedTransaction } from './payment-gateway';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
const notFound = () => new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
const conflict = (message: string) => new AppError(409, 'STATE_CONFLICT', message);
const validation = (message: string) => new AppError(422, 'VALIDATION_ERROR', message);
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const metadataRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return asRecord(JSON.parse(value)); } catch { return {}; } }
  return asRecord(value);
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly idempotency: IdempotencyService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly config: ConfigService,
    private readonly uploads: UploadsService,
    private readonly notifications: NotificationDispatcher,
    private readonly timers: TimersService,
    private readonly outbox: OutboxService,
  ) {}

  async openForCancellation(tx: Prisma.TransactionClient, input: { requestId: string; cancellationId: string; requestedBy: string; workStarted: boolean; now: Date }) {
    const payment = await tx.payment.findFirst({ where: { requestId: input.requestId, status: 'paid' }, orderBy: { paidAt: 'desc' } });
    if (!payment) throw conflict('A settled payment is required before opening a refund.');
    return tx.refund.create({ data: { paymentId: payment.id, requestId: input.requestId, cancellationId: input.cancellationId, amount: payment.amount, status: 'pending_approval', reason: input.workStarted ? 'Cancellation after work started; refund amount requires review.' : 'Cancellation refund review.', requestedBy: input.requestedBy } });
  }

  async getRequestPayments(user: RequestUser, ref: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findRequest(ref);
    if (actor.kind !== 'staff' && request.ownerId !== user.id) throw notFound();
    if (actor.kind === 'staff' && actor.staff?.status !== 'active') throw new AppError(403, 'FORBIDDEN', 'Your staff account is not active.');
    const quote = await this.prisma.quote.findFirst({ where: { requestId: request.id, status: 'accepted' }, orderBy: { version: 'desc' } });
    const rows = await this.prisma.payment.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'desc' } });
    const refunds = await this.prisma.refund.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'desc' } });
    const canViewAmount = actor.kind !== 'staff' || actor.staff?.permissions.has('view.pricing') === true;
    return {
      amountDue: canViewAmount && quote ? Number(quote.total) : 0,
      dueAt: quote?.paymentDueAt ?? null,
      offlineInstructions: (await this.prisma.setting.findUnique({ where: { key: 'payment.offlineInstructions' }, select: { value: true } }))?.value ?? null,
      payments: rows.map((row) => ({ id: row.id, amount: canViewAmount ? Number(row.amount) : null, method: row.method, status: row.status, reference: row.reference, channel: row.channel, paidAt: row.paidAt, createdAt: row.createdAt })),
      refunds: refunds.map((row) => ({ id: row.id, amount: canViewAmount ? Number(row.amount) : undefined, status: row.status, reason: row.reason })),
    };
  }

  async initiate(user: RequestUser, ref: string, key: string, url: string) {
    const actor = await this.actors.resolve(user.id); requireCustomer(actor);
    const requestHash = hashRequest('POST', url, { method: 'paystack' });
    const replay = await this.idempotency.lookup(user.id, key, requestHash);
    if (replay) return replay.body as { paymentId: string; authorizationUrl: string; reference: string };
    const request = await this.findRequest(ref);
    if (request.ownerId !== user.id) throw notFound();
    const quote = await this.prisma.quote.findFirst({ where: { requestId: request.id, status: 'accepted' }, orderBy: { version: 'desc' } });
    if (request.status !== 'awaiting_payment' || !quote) throw conflict('There is no accepted quote awaiting payment.');
    const owner = await this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
    if (!owner?.email) throw validation('Add an email address to your account before paying.');
    const reference = `xpro_${randomUUID().replaceAll('-', '')}`;
    const payment = await this.prisma.payment.create({ data: { requestId: request.id, quoteId: quote.id, quoteVersion: quote.version, amount: quote.total, method: 'paystack', status: 'pending', reference } });
    const result = await this.gateway.initialize({ email: owner.email, amount: Number(quote.total), reference, metadata: { requestId: request.id, quoteId: quote.id, paymentId: payment.id } });
    const response = { paymentId: payment.id, authorizationUrl: result.authorizationUrl, reference };
    await this.idempotency.store(user.id, key, requestHash, 202, response);
    return response;
  }

  async recordOffline(userId: string, ref: string, dto: { amount: number; channel: string; reference: string; paidAt: string; proofFileId: string; note?: string }) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'payment.record');
    const request = await this.findRequest(ref);
    const quote = await this.prisma.quote.findFirst({ where: { requestId: request.id, status: 'accepted' }, orderBy: { version: 'desc' } });
    if (!quote || request.status !== 'awaiting_payment') throw conflict('There is no accepted quote awaiting payment.');
    if (BigInt(dto.amount) !== quote.total) throw validation('The payment amount must match the amount due.');
    if (await this.prisma.payment.findUnique({ where: { reference: dto.reference } })) throw conflict('This payment reference has already been used.');
    const paymentId = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      await this.uploads.attach(tx, [dto.proofFileId], userId, 'payment_proof', 'payment', paymentId);
      return tx.payment.create({ data: { id: paymentId, requestId: request.id, quoteId: quote.id, quoteVersion: quote.version, amount: BigInt(dto.amount), method: 'offline', channel: dto.channel, status: 'recorded', reference: dto.reference, paidAt: new Date(dto.paidAt), proofUploadId: dto.proofFileId, recordedBy: userId, note: dto.note?.trim() || null } });
    });
  }

  async reconcile(userId: string, paymentId: string, note: string) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'payment.record');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.method !== 'offline' || payment.status !== 'recorded') throw conflict('This payment is not awaiting reconciliation.');
    if (payment.recordedBy === userId) throw conflict('Another staff member must reconcile this payment.');
    if (!note.trim()) throw validation('Add a reconciliation note.');
    const settled = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM service_requests WHERE id = ${payment.requestId}::uuid FOR UPDATE`);
      if (!locked.length) throw notFound();
      const request = await tx.serviceRequest.findUnique({ where: { id: payment.requestId } });
      const quote = await tx.quote.findUnique({ where: { id: payment.quoteId } });
      if (!request || !quote) throw notFound();
      if (payment.amount !== quote.total) throw validation('The payment amount must match the amount due.');
      if (request.status !== 'awaiting_payment' || quote.status !== 'accepted') throw conflict('This payment is no longer due for the current request.');
      const changed = await tx.payment.updateMany({ where: { id: payment.id, status: 'recorded', recordedBy: { not: userId } }, data: { status: 'paid', reconciledBy: userId, reconciledAt: new Date(), note: `${payment.note ?? ''}${payment.note ? '\n' : ''}${note.trim()}` } });
      if (!changed.count) throw conflict('This payment is no longer awaiting reconciliation.');
      await this.settleRequest(tx, request.id, payment.id, payment.reference, null);
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
    await this.timers.stop(this.prisma, { requestId: payment.requestId, kinds: ['T9.reminder24h', 'T9.reminder72h', 'T9.lapse'], refId: payment.quoteId });
    await this.outbox.kick();
    return settled;
  }

  async rejectOffline(userId: string, paymentId: string, reason: string) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'payment.record');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.method !== 'offline' || payment.status !== 'recorded') throw conflict('This payment is not awaiting reconciliation.');
    if (payment.recordedBy === userId) throw conflict('Another staff member must review this payment.');
    if (!reason.trim()) throw validation('Add a reason for rejecting this payment.');
    return this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'failed', failureReason: reason.trim(), reconciledBy: userId, reconciledAt: new Date() } });
  }

  async recheckPending(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'pending' || payment.method !== 'paystack') return false;
    const verified = await this.gateway.verify(payment.reference);
    if (!this.matches(verified, payment, await this.getOwnerEmail(payment.requestId))) return false;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.payment.findUnique({ where: { id: payment.id } });
      if (!current || current.status !== 'pending') return;
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'paid', paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(), gatewayTransactionId: verified.id == null ? null : String(verified.id), gatewayChannel: verified.channel ?? null } });
      await this.settleRequest(tx, payment.requestId, payment.id, payment.reference, verified);
    });
    await this.timers.stop(this.prisma, { requestId: payment.requestId, kinds: ['T9.reminder24h', 'T9.reminder72h', 'T9.lapse'], refId: payment.quoteId });
    await this.outbox.kick();
    return true;
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined) {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret || !signature) return false;
    const expected = createHmac('sha512', secret).update(rawBody).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'hex'); } catch { return false; }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined, body: unknown) {
    if (!this.verifyWebhookSignature(rawBody, signature)) throw new UnauthorizedException('Invalid Paystack signature.');
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const event = asRecord(body);
    const eventName = typeof event.event === 'string' ? event.event : 'unknown';
    const data = asRecord(event.data);
    const reference = typeof data.reference === 'string' ? data.reference : null;
    try {
      await this.prisma.gatewayEvent.create({ data: { fingerprint: digest, event: eventName, reference, rawBodyDigest: digest, signatureValid: true, status: 'processing' } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { accepted: true, duplicate: true };
      throw error;
    }
    try {
      if (eventName === 'refund.processed') {
        const refundId = data.id == null ? '' : String(data.id);
        const refund = refundId ? await this.prisma.refund.findFirst({ where: { gatewayRefundId: refundId } }) : null;
        const verified = refund ? await this.gateway.verifyRefund(refundId) : null;
        if (!refund || !verified || verified.status.toLowerCase() !== 'processed' || (verified.amount != null && verified.amount !== Number(refund.amount))) {
          await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'ignored', lastError: 'Refund status could not be verified against an approved refund.', processedAt: new Date() } });
          return { accepted: true, duplicate: false };
        }
        await this.prisma.$transaction([
          this.prisma.refund.update({ where: { id: refund.id }, data: { status: 'completed', completedAt: new Date() } }),
          this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'processed', processedAt: new Date() } }),
        ]);
        await this.resolveCancellation(refund.id);
        return { accepted: true, duplicate: false };
      }
      if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(eventName) && reference) {
        const attempt = await this.prisma.transferAttempt.findUnique({ where: { reference }, include: { payout: true } });
        const verified = attempt ? await this.gateway.verifyTransfer(reference) : null;
        const expectedStatus = eventName === 'transfer.success' ? 'success' : eventName === 'transfer.reversed' ? 'reversed' : 'failed';
        if (!attempt || !verified || verified.reference !== reference || verified.status.toLowerCase() !== expectedStatus) {
          await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'ignored', lastError: 'Transfer status could not be verified.', processedAt: new Date() } });
          return { accepted: true, duplicate: false };
        }
        await this.prisma.$transaction([
          this.prisma.transferAttempt.update({ where: { id: attempt.id }, data: { status: expectedStatus, settledAt: new Date() } }),
          this.prisma.payout.update({ where: { id: attempt.payoutId }, data: { status: expectedStatus === 'success' ? 'paid' : expectedStatus === 'reversed' ? 'reversed' : 'failed', ...(expectedStatus === 'success' ? { paidAt: new Date() } : {}) } }),
          this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'processed', processedAt: new Date() } }),
        ]);
        return { accepted: true, duplicate: false };
      }
      if (eventName !== 'charge.success' || !reference) {
        await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'ignored', processedAt: new Date() } });
        return { accepted: true, duplicate: false };
      }
      const verified = await this.gateway.verify(reference);
      const payment = await this.prisma.payment.findUnique({ where: { reference } });
      if (!payment || !this.matches(verified, payment, await this.getOwnerEmail(payment.requestId))) {
        await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'ignored', lastError: 'Verified transaction did not match the payment record.', processedAt: new Date() } });
        return { accepted: true, duplicate: false };
      }
      if (payment.status === 'paid') {
        await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'processed', processedAt: new Date() } });
        return { accepted: true, duplicate: true };
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'paid', paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(), gatewayTransactionId: verified.id == null ? null : String(verified.id), gatewayChannel: verified.channel ?? null } });
        await this.settleRequest(tx, payment.requestId, payment.id, payment.reference, verified);
        await tx.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'processed', processedAt: new Date() } });
      });
      await this.timers.stop(this.prisma, { requestId: payment.requestId, kinds: ['T9.reminder24h', 'T9.reminder72h', 'T9.lapse'], refId: payment.quoteId });
      await this.outbox.kick();
      return { accepted: true, duplicate: false };
    } catch (error) {
      await this.prisma.gatewayEvent.update({ where: { fingerprint: digest }, data: { status: 'failed', attempts: { increment: 1 }, lastError: error instanceof Error ? error.message : 'Webhook processing failed.' } });
      throw error;
    }
  }

  private matches(verified: VerifiedTransaction, payment: { id: string; amount: bigint; requestId: string; quoteId: string }, ownerEmail: string | null) {
    const metadata = metadataRecord(verified.metadata);
    return verified.status === 'success' && verified.reference && verified.amount === Number(payment.amount) && verified.currency === 'NGN' && verified.customer?.email?.toLowerCase() === ownerEmail?.toLowerCase() && metadata.paymentId === payment.id && metadata.requestId === payment.requestId && metadata.quoteId === payment.quoteId;
  }

  private async settleRequest(tx: Prisma.TransactionClient, requestId: string, paymentId: string, reference: string, verified: VerifiedTransaction | null) {
    const request = await tx.serviceRequest.findUnique({ where: { id: requestId } });
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!request || !payment) throw notFound();
    const quote = await tx.quote.findUnique({ where: { id: payment.quoteId } });
    if (!quote) throw notFound();
    if (request.status !== 'awaiting_payment' || quote.status !== 'accepted') {
      if (!payment.lateRefundOpened) {
        await tx.refund.create({ data: { paymentId, requestId, amount: payment.amount, status: 'pending_approval', reason: 'Late payment received after the request was no longer awaiting payment.', requestedBy: 'system' } });
        await tx.payment.update({ where: { id: paymentId }, data: { lateRefundOpened: true } });
      }
      await this.notifications.dispatch(tx, 'payment.late', { requestCode: `XPR-${String(request.number).padStart(5, '0')}`, reference }, { requestId, ownerId: request.ownerId, actorId: null });
      return;
    }
    await tx.serviceRequest.update({ where: { id: requestId }, data: { status: 'ready_to_schedule', version: { increment: 1 }, updatedAt: new Date() } });
    await this.notifications.dispatch(tx, 'payment.settled_customer', { requestCode: `XPR-${String(request.number).padStart(5, '0')}` }, { requestId, ownerId: request.ownerId, actorId: null });
    await this.notifications.dispatch(tx, 'payment.settled_provider', { requestCode: `XPR-${String(request.number).padStart(5, '0')}` }, { requestId, ownerId: request.ownerId, actorId: null });
  }

  private async getOwnerEmail(requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId }, select: { ownerId: true } });
    if (!request) return null;
    return (await this.prisma.user.findUnique({ where: { id: request.ownerId }, select: { email: true } }))?.email ?? null;
  }

  private async resolveCancellation(refundId: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { cancellationId: true, requestId: true, paymentId: true } });
    if (!refund) return;
    const payment = await this.prisma.payment.findUnique({ where: { id: refund.paymentId }, select: { amount: true } });
    const completed = await this.prisma.refund.aggregate({ where: { paymentId: refund.paymentId, status: { in: ['completed', 'waived'] } }, _sum: { amount: true } });
    const refundedAmount = completed._sum.amount ?? 0n;
    if (payment && refundedAmount > 0n) await this.prisma.payment.update({ where: { id: refund.paymentId }, data: { status: refundedAmount >= payment.amount ? 'refunded' : 'partially_refunded' } });
    if (!refund.cancellationId) return;
    const open = await this.prisma.refund.count({ where: { cancellationId: refund.cancellationId, status: { notIn: ['completed', 'waived'] } } });
    if (open) return;
    await this.prisma.$transaction([
      this.prisma.cancellation.updateMany({ where: { id: refund.cancellationId, status: 'approved' }, data: { status: 'completed' } }),
      this.prisma.serviceRequest.updateMany({ where: { id: refund.requestId, status: 'cancelling' }, data: { status: 'cancelled', version: { increment: 1 }, updatedAt: new Date() } }),
    ]);
  }

  private async findRequest(ref: string) {
    const number = /^XPR-(\d+)$/i.exec(ref)?.[1];
    const request = number ? await this.prisma.serviceRequest.findUnique({ where: { number: Number(number) } }) : await this.prisma.serviceRequest.findUnique({ where: { id: ref } });
    if (!request) throw notFound();
    return request;
  }
}
