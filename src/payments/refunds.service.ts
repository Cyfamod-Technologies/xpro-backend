import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type Payment,
  type Refund,
  type RefundStatus,
} from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { requirePermission } from '../platform/actor/actor.guards';
import { ActorService } from '../platform/actor/actor.service';
import { AppError } from '../platform/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  RequestCommandRunner,
  type CommandContext,
} from '../requests/command-runner';
import { RequestEventsService } from '../requests/events/request-events.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  REFUND_MESSAGES,
  checkDecider,
  checkReconciler,
  checkSecondApprover,
  classifyGatewayRefund,
  planDecision,
  planRefundRequest,
  planSecondApproval,
  refundRegime,
  refundableBalance,
  withinResubmitCooldown,
  type RefundFailure,
} from './domain/refund-rules';
import {
  GatewayRejectedError,
  type GatewayRefund,
  type PaymentGateway,
} from './payment-gateway';
import { PAYMENT_GATEWAY } from './payments.service';
import { refreshPaymentRefundStatus } from './refund-status';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

const NOT_AWAITING_DECISION = 'This refund is no longer awaiting a decision.';
const NOT_AWAITING_SECOND = 'This refund is not awaiting a second approval.';
const NOT_READY_FOR_TRANSFER = 'This offline refund is not ready for transfer.';
const NOT_AWAITING_RECONCILIATION =
  'This offline refund is not awaiting reconciliation.';
// new message: not in spec
const NOT_RETRYABLE = 'This refund cannot be retried.';
// new message: not in spec
const PAYSTACK_ONLY = 'Only Paystack refunds can be retried.';
// new message: not in spec
const STILL_SUBMITTING =
  'This refund was just sent to Paystack. Check it again in a few minutes.';
// new message: not in spec
const NO_REFUNDABLE_PAYMENT = 'This payment has no settled balance to refund.';
const PAYMENT_NOT_FOUND = 'The payment for this refund was not found.';

type Settings = Parameters<RequestCommandRunner['runSystem']>[2];

const refundView = <T extends { payment?: { method: string }; amount: bigint }>(
  row: T,
) => {
  const { payment, ...rest } = row;
  return {
    ...rest,
    amount: Number(row.amount),
    ...(payment ? { method: payment.method } : {}),
  };
};

function raise(failure: RefundFailure): never {
  throw new AppError(failure.status, failure.code, failure.message);
}

const failWith = (failure: RefundFailure | null): void => {
  if (failure) raise(failure);
};

/**
 * Refund commands (05 §4.2, §5, §6.4, §7). Every one follows plan C.4: one
 * transaction on the request runner, the payment row locked `FOR UPDATE`, the
 * refund state claimed with a conditional `updateMany` that must match one
 * row, then audit, notifications and approval items in that transaction. The
 * Paystack call happens after the claim commits and its outcome is recorded in
 * a second transaction. An outcome that cannot be known leaves the refund
 * `processing` with no gateway id; a retry looks the refund up at the gateway
 * before it submits anything again.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly uploads: UploadsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly runner: RequestCommandRunner,
    private readonly requestEvents: RequestEventsService,
  ) {}

  async list(userId: string, page = 1) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const limit = 25;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refund.count(),
    ]);
    const payments = await this.prisma.payment.findMany({
      where: { id: { in: items.map((item) => item.paymentId) } },
      select: { id: true, method: true },
    });
    const methodByPaymentId = new Map(
      payments.map((payment) => [payment.id, payment.method]),
    );
    return {
      items: items.map((row) => ({
        ...row,
        amount: Number(row.amount),
        method: methodByPaymentId.get(row.paymentId) ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    };
  }

  /**
   * `refund.request` (05 §11): Finance asks for a refund of a settled payment,
   * for example to replace a cancellation refund that was rejected or failed.
   * A request raised while the request is `cancelling` joins that
   * cancellation, and then follows its before/after-work rules.
   */
  async request(
    userId: string,
    paymentId: string,
    dto: { amount?: number; reason: string },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const known = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { requestId: true },
    });
    if (!known)
      // new message: not in spec
      throw new AppError(404, 'NOT_FOUND', 'This payment was not found.');
    let createdId = '';
    await this.runner.run(
      {
        command: 'refund.request',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payment = await this.lockPayment(ctx, paymentId);
        if (!['paid', 'partially_refunded'].includes(payment.status))
          throw conflict(NO_REFUNDABLE_PAYMENT);
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: { status: true, cancellationId: true },
        });
        const cancellation =
          request?.status === 'cancelling' && request.cancellationId
            ? await ctx.tx.cancellation.findUnique({
                where: { id: request.cancellationId },
              })
            : null;
        const plan = planRefundRequest({
          regime: refundRegime(cancellation),
          reason: dto.reason,
          requestedAmount:
            dto.amount === undefined ? undefined : BigInt(dto.amount),
          balance: await this.balanceExcluding(ctx, payment),
        });
        if (!plan.ok) raise(plan);
        const refund = await ctx.tx.refund.create({
          data: {
            paymentId,
            requestId: ctx.snap.id,
            cancellationId: cancellation?.id ?? null,
            amount: plan.amount,
            status: 'pending_approval',
            reason: dto.reason.trim(),
            requestedBy: userId,
          },
        });
        createdId = refund.id;
        const replaced = await ctx.tx.refund.findMany({
          where: {
            paymentId,
            status: { in: ['rejected', 'failed'] },
          },
          select: { id: true },
        });
        for (const old of replaced)
          ctx.approvals.close('refund', old.id, 'replaced');
        ctx.approvals.open('refund', refund.id);
        ctx.audit('Refund requested', {
          resourceType: 'refund',
          resourceId: refund.id,
          note: dto.reason.trim(),
          changes: {
            paymentId,
            reference: payment.reference,
            cancellationId: cancellation?.id ?? null,
            amount: Number(plan.amount),
            replacedRefundIds: replaced.map(({ id }) => id),
          },
        });
        ctx.notify('refund.requested', {
          requestCode: ctx.snap.number,
          amount: Number(plan.amount),
        });
        return { bumpVersion: false };
      },
    );
    return this.view(createdId);
  }

  /**
   * `refund.decide` (05 §6.4). The decider is never the requester. Before work
   * starts an approval is the full balance; after work starts every approval,
   * even a zero amount, waits for a Super admin (`secondApprove`). A Paystack
   * refund that is fully approved is claimed straight to `processing` and then
   * submitted once the claim has committed.
   */
  async decide(
    userId: string,
    id: string,
    dto: { approve: boolean; amount?: number; reason: string },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const known = await this.known(id, NOT_AWAITING_DECISION);
    let submit = false;
    await this.runner.run(
      {
        command: 'refund.decide',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const { refund, payment } = await this.lock(
          ctx,
          id,
          known.paymentId,
          NOT_AWAITING_DECISION,
        );
        if (refund.status !== 'pending_approval')
          throw conflict(NOT_AWAITING_DECISION);
        failWith(checkDecider(refund.requestedBy, userId));
        const cancellation = refund.cancellationId
          ? await ctx.tx.cancellation.findUnique({
              where: { id: refund.cancellationId },
            })
          : null;
        const regime = refundRegime(cancellation);
        const plan = planDecision({
          regime,
          approve: dto.approve,
          reason: dto.reason,
          requestedAmount:
            dto.amount === undefined ? undefined : BigInt(dto.amount),
          currentAmount: refund.amount,
          balance: await this.balanceExcluding(ctx, payment, id),
        });
        if (!plan.ok) raise(plan);
        const status =
          plan.status === 'approved' && payment.method === 'paystack'
            ? 'processing'
            : plan.status;
        const claimed = await ctx.tx.refund.updateMany({
          where: { id, status: 'pending_approval' },
          data: {
            amount: plan.amount,
            status,
            decidedBy: userId,
            reason: dto.reason.trim(),
          },
        });
        if (claimed.count !== 1) throw conflict(NOT_AWAITING_DECISION);
        submit = status === 'processing';
        ctx.audit(
          status === 'rejected'
            ? 'Refund rejected'
            : status === 'awaiting_second_approval'
              ? 'Refund approved (awaiting second approval)'
              : 'Refund approved',
          {
            resourceType: 'refund',
            resourceId: id,
            note: dto.reason.trim(),
            changes: this.auditChanges(refund, payment, {
              status,
              amount: plan.amount,
            }),
          },
        );
        if (status === 'rejected') {
          ctx.approvals.close('refund', id, 'rejected');
          if (refund.cancellationId) {
            // 05 §6.4: the cancellation stays open until a new valid decision exists.
            ctx.approvals.open('refund', id);
            ctx.notify('refund.rejected', { requestCode: ctx.snap.number });
          }
        } else if (status !== 'awaiting_second_approval')
          ctx.approvals.close('refund', id, 'approved');
        return { bumpVersion: false };
      },
    );
    if (submit) await this.submit(actor, id);
    return this.view(id);
  }

  /** `refund.secondApprove` (05 §5): a Super admin other than the first decider signs off a refund decided after work started. */
  async secondApprove(
    userId: string,
    id: string,
    dto: { approve: boolean; reason: string },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const known = await this.known(id, NOT_AWAITING_SECOND);
    let submit = false;
    let resolvedAfterCommit: (() => Promise<void>) | undefined;
    await this.runner.run(
      {
        command: 'refund.secondApprove',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const { refund, payment } = await this.lock(
          ctx,
          id,
          known.paymentId,
          NOT_AWAITING_SECOND,
        );
        if (refund.status !== 'awaiting_second_approval')
          throw conflict(NOT_AWAITING_SECOND);
        failWith(
          checkSecondApprover({
            decidedBy: refund.decidedBy,
            userId,
            isSuperAdmin: actor.staff?.isSuperAdmin === true,
          }),
        );
        const plan = planSecondApproval({
          approve: dto.approve,
          reason: dto.reason,
          amount: refund.amount,
          balance: await this.balanceExcluding(ctx, payment, id),
        });
        if (!plan.ok) raise(plan);
        const status =
          plan.status === 'approved' && payment.method === 'paystack'
            ? 'processing'
            : plan.status;
        const claimed = await ctx.tx.refund.updateMany({
          where: { id, status: 'awaiting_second_approval' },
          data: {
            status,
            secondApprover: userId,
            ...(status === 'rejected' ? { reason: dto.reason.trim() } : {}),
            ...(status === 'waived' ? { completedAt: ctx.now } : {}),
          },
        });
        if (claimed.count !== 1) throw conflict(NOT_AWAITING_SECOND);
        submit = status === 'processing';
        ctx.audit(
          status === 'rejected'
            ? 'Refund rejected (second approval)'
            : status === 'waived'
              ? 'Refund waived'
              : 'Refund approved (second approval)',
          {
            resourceType: 'refund',
            resourceId: id,
            note: dto.reason.trim(),
            changes: {
              ...this.auditChanges(refund, payment, {
                status,
                amount: refund.amount,
              }),
              decidedBy: refund.decidedBy,
              secondApprover: userId,
            },
          },
        );
        if (status === 'rejected') {
          ctx.approvals.close('refund', id, 'rejected');
          if (refund.cancellationId) {
            ctx.approvals.open('refund', id);
            ctx.notify('refund.rejected', { requestCode: ctx.snap.number });
          }
        } else {
          ctx.approvals.close('refund', id, status);
          if (status === 'waived' && refund.cancellationId) {
            const resolved = await this.requestEvents.onRefundsResolved(
              ctx.tx,
              refund.cancellationId,
            );
            resolvedAfterCommit = resolved.afterCommit;
          }
        }
        return { bumpVersion: false };
      },
    );
    await resolvedAfterCommit?.();
    if (submit) await this.submit(actor, id);
    return this.view(id);
  }

  /** `refund.recordTransfer` (05 §6.4): Finance records the outgoing bank transfer of an offline refund, with proof. */
  async recordTransfer(
    userId: string,
    id: string,
    dto: { reference: string; proofFileId: string; note?: string },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const known = await this.known(id, NOT_READY_FOR_TRANSFER);
    await this.runner.run(
      {
        command: 'refund.recordTransfer',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const { refund, payment } = await this.lock(
          ctx,
          id,
          known.paymentId,
          NOT_READY_FOR_TRANSFER,
        );
        if (refund.status !== 'approved' || payment.method !== 'offline')
          throw conflict(NOT_READY_FOR_TRANSFER);
        const note = dto.note?.trim();
        const claimed = await ctx.tx.refund.updateMany({
          where: { id, status: 'approved' },
          data: {
            status: 'processing',
            transferReference: dto.reference,
            transferProofId: dto.proofFileId,
            transferRecordedBy: userId,
            ...(note ? { reason: `${refund.reason}\n${note}` } : {}),
          },
        });
        if (claimed.count !== 1) throw conflict(NOT_READY_FOR_TRANSFER);
        await this.uploads.attach(
          ctx.tx,
          [dto.proofFileId],
          userId,
          'payment_proof',
          'refund',
          id,
        );
        ctx.audit('Refund transfer recorded', {
          resourceType: 'refund',
          resourceId: id,
          note,
          changes: {
            ...this.auditChanges(refund, payment, {
              status: 'processing',
              amount: refund.amount,
            }),
            transferReference: dto.reference,
            proofFileId: dto.proofFileId,
          },
        });
        return { bumpVersion: false };
      },
    );
    return this.view(id);
  }

  /**
   * `refund.reconcile` (05 §6.4): a second person confirms the offline
   * transfer. The reconciler is neither the one who recorded the transfer nor
   * the refund's requester, and may not complete a refund they started.
   */
  async reconcile(userId: string, id: string, note: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const known = await this.known(id, NOT_AWAITING_RECONCILIATION);
    let resolvedAfterCommit: (() => Promise<void>) | undefined;
    await this.runner.run(
      {
        command: 'refund.reconcile',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const { refund, payment } = await this.lock(
          ctx,
          id,
          known.paymentId,
          NOT_AWAITING_RECONCILIATION,
        );
        if (refund.status !== 'processing' || !refund.transferRecordedBy)
          throw conflict(NOT_AWAITING_RECONCILIATION);
        failWith(
          checkReconciler({
            requestedBy: refund.requestedBy,
            transferRecordedBy: refund.transferRecordedBy,
            userId,
          }),
        );
        // new message: not in spec
        if (!note.trim())
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a reconciliation note.',
          );
        const claimed = await ctx.tx.refund.updateMany({
          where: {
            id,
            status: 'processing',
            transferRecordedBy: { not: userId },
            requestedBy: { not: userId },
          },
          data: {
            status: 'completed',
            reconciledBy: userId,
            completedAt: ctx.now,
            reason: `${refund.reason}\nReconciled: ${note.trim()}`,
          },
        });
        if (claimed.count !== 1) throw conflict(NOT_AWAITING_RECONCILIATION);
        await refreshPaymentRefundStatus(ctx.tx, refund.paymentId);
        ctx.approvals.close('refund', id, 'completed');
        ctx.audit('Refund reconciled', {
          resourceType: 'refund',
          resourceId: id,
          note: note.trim(),
          changes: {
            ...this.auditChanges(refund, payment, {
              status: 'completed',
              amount: refund.amount,
            }),
            transferRecordedBy: refund.transferRecordedBy,
            reconciledBy: userId,
          },
        });
        if (refund.cancellationId) {
          const resolved = await this.requestEvents.onRefundsResolved(
            ctx.tx,
            refund.cancellationId,
          );
          resolvedAfterCommit = resolved.afterCommit;
        }
        return { bumpVersion: false };
      },
    );
    await resolvedAfterCommit?.();
    return this.view(id);
  }

  /**
   * `refund.retry` (05 §6.4, §8): a Paystack refund that failed, or whose
   * submission outcome is unknown, is first looked up at the gateway, by its
   * gateway refund id when it has one and by the transaction otherwise. A
   * refund that is processed or still on its way is brought up to date and
   * nothing is submitted. Only a refund the gateway reports as failed, or
   * does not know, is resubmitted.
   */
  async retry(userId: string, id: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'refund.manage');
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    const payment = refund
      ? await this.prisma.payment.findUnique({
          where: { id: refund.paymentId },
        })
      : null;
    if (!refund || !payment) throw conflict(NOT_RETRYABLE);
    if (payment.method !== 'paystack') throw conflict(PAYSTACK_ONLY);
    if (refund.status !== 'failed' && refund.status !== 'processing')
      throw conflict(NOT_RETRYABLE);
    if (
      refund.status === 'processing' &&
      !refund.gatewayRefundId &&
      withinResubmitCooldown(refund.updatedAt, new Date())
    )
      throw conflict(STILL_SUBMITTING);

    const found = await this.lookup(refund, payment);
    if (found && classifyGatewayRefund(found.status) !== 'failed') {
      await this.settleFromGateway(refund.id, found, { actor });
      return this.view(id);
    }
    await this.runner.run(
      {
        command: 'refund.retry',
        actor,
        requestRef: refund.requestId,
        guard: null,
      },
      async (ctx) => {
        const locked = await this.lock(
          ctx,
          id,
          refund.paymentId,
          NOT_RETRYABLE,
        );
        if (
          (await this.balanceExcluding(ctx, locked.payment, id)) <
          locked.refund.amount
        )
          throw new AppError(422, 'VALIDATION_ERROR', REFUND_MESSAGES.exceeds);
        // `updatedAt` is the refund's version: only one retry can take it.
        const claimed = await ctx.tx.refund.updateMany({
          where: {
            id,
            status: refund.status,
            gatewayRefundId: refund.gatewayRefundId,
            updatedAt: refund.updatedAt,
          },
          data: { status: 'processing', gatewayRefundId: null },
        });
        if (claimed.count !== 1) throw conflict(NOT_RETRYABLE);
        ctx.approvals.close('refund', id, 'retried');
        ctx.audit('Refund resubmitted', {
          resourceType: 'refund',
          resourceId: id,
          changes: {
            ...this.auditChanges(locked.refund, locked.payment, {
              status: 'processing',
              amount: locked.refund.amount,
            }),
            previousGatewayRefundId: refund.gatewayRefundId,
            gatewayState: found?.status ?? 'not found',
          },
        });
        return { bumpVersion: false };
      },
    );
    await this.submit(actor, id);
    return this.view(id);
  }

  /**
   * Applies a gateway refund state that was verified with the gateway: a
   * `processed` refund completes (refund, payment status and the request's
   * `cancelling -> cancelled` in ONE transaction), a `failed` or
   * `needs-attention` one becomes `failed` with a Finance notice and item, and
   * one still on its way is adopted as `processing`. Each change is a
   * conditional claim; a claim that matches nothing (a duplicate or
   * out-of-order event) writes nothing. `onSettled` runs in the same
   * transaction, so the gateway inbox row closes with the money.
   */
  async settleFromGateway(
    refundId: string,
    gateway: GatewayRefund,
    options: {
      actor: ActorContext | null;
      onSettled?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ): Promise<{ applied: boolean }> {
    const known = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { requestId: true, paymentId: true },
    });
    if (!known) return { applied: false };
    const state = classifyGatewayRefund(gateway.status);
    let applied = false;
    let afterCommit: (() => Promise<void>) | undefined;
    await this.inTransaction(
      options.actor,
      'refund.gatewaySettled',
      known.requestId,
      async (ctx) => {
        const { refund, payment } = await this.lock(
          ctx,
          refundId,
          known.paymentId,
          NOT_AWAITING_RECONCILIATION,
        );
        const sameRefund = [
          { gatewayRefundId: null },
          { gatewayRefundId: gateway.id },
        ];
        if (
          gateway.amount != null &&
          gateway.amount !== Number(refund.amount)
        ) {
          await options.onSettled?.(ctx.tx);
          return { bumpVersion: false };
        }
        if (
          state === 'in_flight' &&
          refund.status === 'processing' &&
          refund.gatewayRefundId === gateway.id
        ) {
          await options.onSettled?.(ctx.tx);
          return { bumpVersion: false };
        }
        const claim = await ctx.tx.refund.updateMany({
          where: {
            id: refundId,
            status:
              state === 'failed'
                ? 'processing'
                : { in: ['processing', 'failed'] as RefundStatus[] },
            OR: sameRefund,
          },
          data:
            state === 'processed'
              ? {
                  status: 'completed',
                  completedAt: ctx.now,
                  gatewayRefundId: gateway.id,
                }
              : state === 'failed'
                ? { status: 'failed', gatewayRefundId: gateway.id }
                : { status: 'processing', gatewayRefundId: gateway.id },
        });
        if (claim.count === 1) {
          applied = true;
          const after = {
            status:
              state === 'processed'
                ? 'completed'
                : state === 'failed'
                  ? 'failed'
                  : 'processing',
            amount: refund.amount,
          };
          if (state === 'processed') {
            await refreshPaymentRefundStatus(ctx.tx, refund.paymentId);
            ctx.approvals.close('refund', refundId, 'completed');
            ctx.audit('Refund completed', {
              resourceType: 'refund',
              resourceId: refundId,
              changes: {
                ...this.auditChanges(refund, payment, after),
                gatewayRefundId: gateway.id,
              },
            });
            if (refund.cancellationId)
              afterCommit = (
                await this.requestEvents.onRefundsResolved(
                  ctx.tx,
                  refund.cancellationId,
                )
              ).afterCommit;
          } else if (state === 'failed') {
            ctx.audit('Refund failed at the gateway', {
              resourceType: 'refund',
              resourceId: refundId,
              changes: {
                ...this.auditChanges(refund, payment, after),
                gatewayRefundId: gateway.id,
                gatewayStatus: gateway.status,
              },
            });
            ctx.approvals.open('refund', refundId);
            ctx.notify('refund.failed', {
              requestCode: ctx.snap.number,
              amount: Number(refund.amount),
              detail: 'Paystack reported that it failed.',
            });
          } else {
            if (refund.status === 'failed')
              ctx.approvals.close('refund', refundId, 'in_progress');
            ctx.audit('Refund found in progress at the gateway', {
              resourceType: 'refund',
              resourceId: refundId,
              changes: {
                ...this.auditChanges(refund, payment, after),
                gatewayRefundId: gateway.id,
              },
            });
          }
        }
        await options.onSettled?.(ctx.tx);
        return { bumpVersion: false };
      },
    );
    await afterCommit?.();
    return { applied };
  }

  /** The gateway call, after the claim has committed. C-02: the payment reference is loaded here, never taken from a partial include. */
  private async submit(actor: ActorContext | null, id: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    const payment = refund
      ? await this.prisma.payment.findUnique({
          where: { id: refund.paymentId },
        })
      : null;
    if (
      !refund ||
      !payment ||
      refund.status !== 'processing' ||
      refund.gatewayRefundId
    )
      return;
    let result: { id: string; status: string };
    try {
      result = await this.gateway.refund({
        reference: payment.reference,
        amount: Number(refund.amount),
        reason: refund.reason,
      });
    } catch (error) {
      await this.recordFailure(actor, refund, payment, error);
      throw error;
    }
    await this.inTransaction(
      actor,
      'refund.gatewaySubmitted',
      refund.requestId,
      async (ctx) => {
        await this.lockPayment(ctx, refund.paymentId);
        const claimed = await ctx.tx.refund.updateMany({
          where: { id, status: 'processing', gatewayRefundId: null },
          data: { gatewayRefundId: result.id },
        });
        if (claimed.count !== 1) return { changed: false };
        ctx.audit('Refund submitted to Paystack', {
          resourceType: 'refund',
          resourceId: id,
          changes: {
            ...this.auditChanges(refund, payment, {
              status: 'processing',
              amount: refund.amount,
            }),
            gatewayRefundId: result.id,
          },
        });
        return { bumpVersion: false };
      },
    );
  }

  /**
   * A refusal from Paystack leaves the refund `failed`. Any other error leaves
   * it `processing`, because the refund may exist at Paystack; Finance still
   * gets the notice and the item, and a retry looks it up first.
   */
  private async recordFailure(
    actor: ActorContext | null,
    refund: Refund,
    payment: Payment,
    error: unknown,
  ): Promise<void> {
    const refused = error instanceof GatewayRejectedError;
    try {
      await this.inTransaction(
        actor,
        'refund.gatewayFailed',
        refund.requestId,
        async (ctx) => {
          await this.lockPayment(ctx, refund.paymentId);
          if (refused) {
            const claimed = await ctx.tx.refund.updateMany({
              where: {
                id: refund.id,
                status: 'processing',
                gatewayRefundId: null,
              },
              data: { status: 'failed' },
            });
            if (claimed.count !== 1) return { changed: false };
          }
          ctx.audit(
            refused
              ? 'Refund failed at the gateway'
              : 'Refund submission not confirmed',
            {
              resourceType: 'refund',
              resourceId: refund.id,
              changes: this.auditChanges(refund, payment, {
                status: refused ? 'failed' : 'processing',
                amount: refund.amount,
              }),
            },
          );
          ctx.approvals.open('refund', refund.id);
          ctx.notify('refund.failed', {
            requestCode: ctx.snap.number,
            amount: Number(refund.amount),
            detail: refused
              ? 'Paystack refused it.'
              : 'Paystack did not confirm it.',
          });
          return { bumpVersion: false };
        },
      );
    } catch (recordError) {
      this.logger.error(
        `Could not record the failed gateway refund ${refund.id}: ${String(recordError)}`,
      );
    }
  }

  /** The refund at the gateway: by its gateway id, or, when its submission outcome was lost, by matching an unclaimed refund of the same amount on the transaction. */
  private async lookup(
    refund: Refund,
    payment: Payment,
  ): Promise<GatewayRefund | null> {
    if (refund.gatewayRefundId)
      return this.gateway.verifyRefund(refund.gatewayRefundId);
    const listed = await this.gateway.listRefunds(payment.reference);
    if (!listed.length) return null;
    const owned = await this.prisma.refund.findMany({
      where: {
        gatewayRefundId: { in: listed.map(({ id }) => id) },
        id: { not: refund.id },
      },
      select: { gatewayRefundId: true },
    });
    const taken = new Set(owned.map(({ gatewayRefundId }) => gatewayRefundId));
    return (
      listed.find(
        (candidate) =>
          !taken.has(candidate.id) &&
          candidate.amount === Number(refund.amount),
      ) ?? null
    );
  }

  private inTransaction(
    actor: ActorContext | null,
    command: string,
    requestId: string,
    fn: Settings,
  ) {
    return actor
      ? this.runner.run(
          { command, actor, requestRef: requestId, guard: null },
          fn,
        )
      : this.runner.runSystem(command, requestId, fn);
  }

  private async known(id: string, message: string) {
    const row = await this.prisma.refund.findUnique({
      where: { id },
      select: { requestId: true, paymentId: true },
    });
    if (!row) throw conflict(message);
    return row;
  }

  /** Request first (the runner), then payment, then refund: the same order everywhere, so concurrent refunds queue instead of deadlocking. */
  private async lockPayment(
    ctx: CommandContext,
    paymentId: string,
  ): Promise<Payment> {
    await ctx.tx.$queryRaw(
      Prisma.sql`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`,
    );
    const payment = await ctx.tx.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw conflict(PAYMENT_NOT_FOUND);
    return payment;
  }

  private async lock(
    ctx: CommandContext,
    id: string,
    paymentId: string,
    missing: string,
  ): Promise<{ refund: Refund; payment: Payment }> {
    const payment = await this.lockPayment(ctx, paymentId);
    const refund = await ctx.tx.refund.findUnique({ where: { id } });
    if (!refund) throw conflict(missing);
    return { refund, payment };
  }

  private async balanceExcluding(
    ctx: CommandContext,
    payment: Payment,
    refundId?: string,
  ): Promise<bigint> {
    return refundableBalance(
      payment.amount,
      await ctx.tx.refund.findMany({
        where: {
          paymentId: payment.id,
          ...(refundId ? { id: { not: refundId } } : {}),
        },
        select: { amount: true, status: true },
      }),
    );
  }

  private auditChanges(
    refund: Refund,
    payment: Payment,
    after: { status: string; amount: bigint },
  ) {
    return {
      paymentId: payment.id,
      reference: payment.reference,
      cancellationId: refund.cancellationId,
      before: { status: refund.status, amount: Number(refund.amount) },
      after: { status: after.status, amount: Number(after.amount) },
    };
  }

  private async view(id: string) {
    const row = await this.prisma.refund.findUniqueOrThrow({ where: { id } });
    const payment = await this.prisma.payment.findUnique({
      where: { id: row.paymentId },
      select: { method: true },
    });
    return refundView({ ...row, ...(payment ? { payment } : {}) });
  }
}
