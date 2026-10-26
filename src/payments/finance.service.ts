import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PayoutStatus, type Payout } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../common/utils/crypto.util';
import { requirePermission } from '../platform/actor/actor.guards';
import type { ActorContext } from '../platform/actor/actor.types';
import { ActorService } from '../platform/actor/actor.service';
import { AppError } from '../platform/errors/app-error';
import {
  hashRequest,
  IdempotencyService,
} from '../platform/idempotency/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  RequestCommandRunner,
  type CommandContext,
} from '../requests/command-runner';
import { UploadsService } from '../uploads/uploads.service';
import {
  PAYOUT_MESSAGES,
  bankVersionOf,
  checkPayoutApproval,
  checkRelease,
  checkSecondApprover,
  classifyGatewayTransfer,
  closureStateOf,
  currentApprovals,
  decideTransferRetry,
  holdAction,
  needsSecondApproval,
  newTransferReference,
  parseStatusFilter,
  planPrimaryPayout,
  planSecondApproval,
  planTransferEvent,
  type ClosureState,
  type HoldSource,
  type PayoutFailure,
  type TransferOutcome,
} from './domain/payout-rules';
import { GatewayRejectedError, type PaymentGateway } from './payment-gateway';
import { PAYMENT_GATEWAY } from './payments.service';
import { assertExpectedVersion } from './record-version';
import {
  toEarningsItem,
  toPayoutDto,
  toPayoutQueueItem,
  safeHoldReason,
  type PayoutQueueItem,
} from './payout.projection';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const notFound = () =>
  // new message: not in spec
  new AppError(404, 'NOT_FOUND', 'This payout was not found.');

function raise(failure: PayoutFailure): never {
  throw new AppError(failure.status, failure.code, failure.message);
}

const failWith = (failure: PayoutFailure | null): void => {
  if (failure) raise(failure);
};

const invalidReason = () =>
  new AppError(422, 'VALIDATION_ERROR', PAYOUT_MESSAGES.addReason);

const PAGE_SIZE = 25;

type PayoutWithApprovals = Prisma.PayoutGetPayload<{
  include: { approvals: true };
}>;
type CommandFn = Parameters<RequestCommandRunner['runSystem']>[2];

/** What `createPrimary` needs from a command context: the transaction, the clock, the settings and the ordered effects. */
export type PayoutCreationContext = Pick<
  CommandContext,
  'tx' | 'now' | 'settings' | 'approvals' | 'audit' | 'notify' | 'snap'
>;

export type IdempotencyInput = { key: string; url: string };

const holidaysOf = (settings: Readonly<Record<string, unknown>>): string[] => {
  const holidays = settings['calendar.holidays'];
  return Array.isArray(holidays) ? (holidays as string[]) : [];
};

const approvalMinutes = (
  settings: Readonly<Record<string, unknown>>,
): number | undefined => {
  const deadlines = settings['approvals.deadlines'];
  const minutes =
    deadlines && typeof deadlines === 'object'
      ? (deadlines as Record<string, unknown>).payout
      : undefined;
  return typeof minutes === 'number' ? minutes : undefined;
};

/**
 * Primary payouts and their transfers (05 §4.3, §5, §6.5, §6.6, §7). Every
 * command follows plan C.4: one transaction on the request runner, the payout
 * row locked `FOR UPDATE`, the state claimed with a conditional `updateMany`
 * that must match one row, then audit, notifications and approval items in that
 * transaction. The Paystack call happens after the claim commits, and its
 * outcome is recorded in a second transaction. An outcome that cannot be known
 * leaves the payout `processing` and the attempt `pending`; a retry verifies
 * that attempt with Paystack before it creates another.
 */
@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly uploads: UploadsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly runner: RequestCommandRunner,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Creates the one primary payout of a request when completion is confirmed
   * (customer, 72-hour auto-confirm or staff on behalf; FD-7). Idempotent: an
   * existing primary payout that is not cancelled is returned. The amount is
   * `quote.payoutAmount`, and only when `payoutAssignmentId` names the current
   * assignment; otherwise the confirmation is refused with 409, because paying
   * the figure set for a replaced provider would pay the wrong amount. The
   * payout is due for first approval 20 working hours later, starts `on_hold`
   * when an issue is open, in rework or disputed or the provider is blocked,
   * and opens the `payout` approval item either way.
   */
  async createPrimary(
    ctx: PayoutCreationContext,
    input: {
      requestId: string;
      assignmentId: string;
      providerId: string;
      amount: bigint | null;
      payoutAssignmentId: string | null;
    },
  ): Promise<Payout> {
    const { tx } = ctx;
    if (
      input.amount == null ||
      input.amount <= 0n ||
      input.payoutAssignmentId !== input.assignmentId
    )
      throw conflict(PAYOUT_MESSAGES.noPayoutAmount);
    const existing = await tx.payout.findFirst({
      where: {
        requestId: input.requestId,
        kind: 'primary',
        status: { not: 'cancelled' },
      },
    });
    if (existing) {
      if (existing.assignmentId !== input.assignmentId)
        throw conflict(PAYOUT_MESSAGES.otherPrimaryActive);
      return existing;
    }
    const issues = await tx.issue.findMany({
      where: { requestId: input.requestId },
      select: { status: true },
    });
    const provider = await tx.providerProfile.findUnique({
      where: { id: input.providerId },
      select: {
        userId: true,
        verification: true,
        reliabilityStatus: true,
        user: { select: { status: true } },
      },
    });
    const bank = await tx.providerBankAccount.findFirst({
      where: { providerId: input.providerId, state: 'verified' },
      orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, last4: true },
    });
    const plan = planPrimaryPayout({
      now: ctx.now,
      holidays: holidaysOf(ctx.settings),
      approvalMinutes: approvalMinutes(ctx.settings),
      issueStatuses: issues.map(({ status }) => status),
      provider: {
        userStatus: provider?.user.status ?? null,
        verification: provider?.verification ?? null,
        reliabilityStatus: provider?.reliabilityStatus ?? null,
      },
    });
    const payout = await tx.payout.create({
      data: {
        requestId: input.requestId,
        assignmentId: input.assignmentId,
        providerId: input.providerId,
        kind: 'primary',
        amount: input.amount,
        status: plan.status,
        holdReason: plan.holdReason,
        holdSource: plan.holdSource,
        approvalDueAt: plan.approvalDueAt,
        bankAccountId: bank?.id ?? null,
        createdAt: ctx.now,
      },
    });
    ctx.approvals.open('payout', payout.id);
    ctx.audit('Payout created', {
      resourceType: 'payout',
      resourceId: payout.id,
      changes: {
        assignmentId: input.assignmentId,
        amount: Number(input.amount),
        status: plan.status,
        holdSource: plan.holdSource,
        approvalDueAt: plan.approvalDueAt.toISOString(),
        before: null,
        after: { status: plan.status, amount: Number(input.amount) },
      },
    });
    ctx.notify('payout.created', {
      requestCode: ctx.snap.number,
      amount: Number(input.amount),
      dueDate: plan.approvalDueAt.toLocaleDateString('en-NG', {
        timeZone: 'Africa/Lagos',
      }),
      onHold: plan.status === 'on_hold',
    });
    const heldReason = safeHoldReason(plan.status, plan.holdSource);
    if (provider && heldReason)
      ctx.notify('payout.held', {
        requestCode: ctx.snap.number,
        assignmentId: input.assignmentId,
        providerUserId: provider.userId,
        reason: heldReason,
      });
    return payout;
  }

  /** 05 §10: Finance sees the queue; amounts need `view.pricing`. Rows are an allow-list, never the stored row (C-42, E-27). */
  async payouts(
    userId: string,
    query: { page?: number; status?: string } = {},
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const filter = parseStatusFilter(query.status, Object.values(PayoutStatus));
    if (!filter.ok) raise(filter);
    const canSeePricing = actor.staff?.permissions.has('view.pricing') ?? false;
    const page = Math.max(1, query.page ?? 1);
    const where: Prisma.PayoutWhereInput = filter.status
      ? { status: filter.status }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.payout.count({ where }),
    ]);
    const providers = await this.prisma.providerProfile.findMany({
      where: { id: { in: items.map((item) => item.providerId) } },
      select: { id: true, businessName: true },
    });
    const nameById = new Map(
      providers.map((provider) => [provider.id, provider.businessName]),
    );
    return {
      items: items.map((row) =>
        toPayoutQueueItem(
          row,
          nameById.get(row.providerId) ?? null,
          canSeePricing,
        ),
      ),
      total,
      page,
      limit: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
      hasNextPage: page * PAGE_SIZE < total,
      hasPrevPage: page > 1,
    };
  }

  /**
   * `payout.approve` (05 §6.5). Re-checks the request, the collection, issues,
   * the provider and the provider's current bank, then claims
   * `pending_approval`. An amount above `payout.secondApprovalThreshold` waits
   * for a second approver.
   */
  async approvePayout(
    userId: string,
    id: string,
    note?: string,
    expectedVersion?: number,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const known = await this.known(id);
    await this.runner.run(
      {
        command: 'payout.approve',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payout = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, payout.version);
        if (payout.status !== 'pending_approval')
          throw conflict(PAYOUT_MESSAGES.notAwaitingApproval);
        const facts = await this.bankFacts(ctx, payout.providerId);
        const provider = await this.providerFacts(ctx, payout.providerId);
        failWith(
          checkPayoutApproval({
            approverId: userId,
            now: ctx.now,
            requestStatus: ctx.snap.status,
            requestHold: ctx.snap.hold?.kind ?? null,
            issueStatuses: ctx.snap.openIssues.map(({ status }) => status),
            collectionSettled: ctx.snap.payment.paid,
            provider,
            bank: facts.bank,
            pendingBankChange: facts.pendingBankChange,
          }),
        );
        const bank = facts.bank;
        if (!bank) throw conflict(PAYOUT_MESSAGES.bankDetails);
        const second = needsSecondApproval(
          payout.amount,
          ctx.settings['payout.secondApprovalThreshold'],
        );
        const status = second ? 'awaiting_second_approval' : 'approved';
        const claimed = await ctx.tx.payout.updateMany({
          where: { id, status: 'pending_approval' },
          data: {
            status,
            bankAccountId: bank.id,
            bankLast4: bank.last4,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1)
          throw conflict(PAYOUT_MESSAGES.notAwaitingApproval);
        await ctx.tx.payoutApproval.create({
          data: {
            payoutId: id,
            step: 1,
            actorId: userId,
            note: note?.trim() || null,
            bankVersion: bankVersionOf(bank),
          },
        });
        ctx.approvals.close('payout', id, 'approved');
        if (second) {
          ctx.approvals.open('payout_second', id);
          ctx.notify('payout.second_approval_needed', {
            requestCode: ctx.snap.number,
            amount: Number(payout.amount),
          });
        }
        ctx.audit('Payout approved', {
          resourceType: 'payout',
          resourceId: id,
          note: note?.trim() || undefined,
          changes: this.change(payout, status, {
            bankLast4: bank.last4,
            secondApprovalRequired: second,
          }),
        });
        return { bumpVersion: false };
      },
    );
    return this.view(id, actor);
  }

  /**
   * `payout.secondApprove` (05 §5, Q14): any `payout.approve` holder other than
   * the first approver. Approving moves to `approved`; rejecting returns the
   * payout to `pending_approval` with the note, so the request cannot close on it.
   */
  async secondApprovePayout(
    userId: string,
    id: string,
    approve: boolean,
    note: string,
    expectedVersion?: number,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const known = await this.known(id);
    await this.runner.run(
      {
        command: 'payout.secondApprove',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payout = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, payout.version);
        if (payout.status !== 'awaiting_second_approval')
          throw conflict(PAYOUT_MESSAGES.notAwaitingSecond);
        const { bank } = await this.bankFacts(ctx, payout.providerId);
        const bankVersion = bank ? bankVersionOf(bank) : null;
        const approvals = currentApprovals(payout.approvals, bankVersion);
        const firstApprovalCurrent = approvals.some(({ step }) => step === 1);
        failWith(checkSecondApprover({ userId, approvals: payout.approvals }));
        const plan = planSecondApproval({
          approve,
          note,
          firstApprovalCurrent,
        });
        if (!plan.ok) raise(plan);
        const claimed = await ctx.tx.payout.updateMany({
          where: { id, status: 'awaiting_second_approval' },
          data: { status: plan.status, version: { increment: 1 } },
        });
        if (claimed.count !== 1)
          throw conflict(PAYOUT_MESSAGES.notAwaitingSecond);
        await ctx.tx.payoutApproval.create({
          data: {
            payoutId: id,
            step: 2,
            actorId: userId,
            note: note.trim(),
            bankVersion,
          },
        });
        ctx.approvals.close(
          'payout_second',
          id,
          approve ? 'approved' : 'rejected',
        );
        if (!approve) ctx.approvals.open('payout', id);
        ctx.audit(
          approve
            ? 'Payout second approval given'
            : 'Payout second approval rejected',
          {
            resourceType: 'payout',
            resourceId: id,
            note: note.trim(),
            changes: this.change(payout, plan.status, {
              firstApprover:
                payout.approvals.find(({ step }) => step === 1)?.actorId ??
                null,
            }),
          },
        );
        return { bumpVersion: false };
      },
    );
    return this.view(id, actor);
  }

  /**
   * `payout.hold` and `payout.release` (05 §5, §6.6). An unpaid payout,
   * including a `failed` one, goes `on_hold` and back to `pending_approval`.
   * A `processing` transfer cannot be stopped, so a hold flags it for urgent
   * Finance review instead. The person who acted is in the audit row; the
   * `holdSource` column says why (C-40).
   */
  async payoutHold(
    userId: string,
    id: string,
    hold: boolean,
    reason: string,
    expectedVersion?: number,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const known = await this.known(id);
    if (!reason.trim()) throw invalidReason();
    await this.runner.run(
      {
        command: hold ? 'payout.hold' : 'payout.release',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payout = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, payout.version);
        return hold
          ? this.applyHold(ctx, payout, reason.trim())
          : this.applyRelease(ctx, payout, reason.trim());
      },
    );
    return this.view(id, actor);
  }

  /**
   * `payout.transfer` (05 §6.5). The payout is claimed `approved ->
   * processing` and its transfer attempt, with the FD-8 reference, is written
   * in that same transaction, before Paystack is called. Two concurrent calls
   * therefore make one transfer. A gateway error or timeout leaves the attempt
   * `pending` and the payout `processing`; use `retryTransfer` to resolve it.
   */
  async transferPayout(
    userId: string,
    id: string,
    dto:
      | { method: 'paystack' }
      | { method: 'offline'; reference: string; proofFileId: string },
    idempotency: IdempotencyInput,
    expectedVersion?: number,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const hash = hashRequest('POST', idempotency.url, dto);
    const replay = await this.idempotency.lookup(userId, idempotency.key, hash);
    if (replay) return replay.body;
    const result =
      dto.method === 'offline'
        ? await this.transferOffline(actor, userId, id, dto, expectedVersion)
        : await this.transferPaystack(actor, id, expectedVersion);
    return this.store(userId, idempotency, hash, result);
  }

  /**
   * `payout.retry` (05 §6.5, §7). Asks Paystack about the latest attempt
   * first. A transfer that went through is settled, one still on its way is
   * waited for, and only an attempt Paystack confirms `failed` or `reversed`,
   * or does not know at all, is replaced by a new attempt with a new reference.
   */
  async retryTransfer(
    userId: string,
    id: string,
    idempotency: IdempotencyInput,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const hash = hashRequest('POST', idempotency.url, {});
    const replay = await this.idempotency.lookup(userId, idempotency.key, hash);
    if (replay) return replay.body;
    const payout = await this.prisma.payout.findUnique({
      where: { id },
      include: { approvals: true },
    });
    if (!payout) throw notFound();
    const latest = await this.prisma.transferAttempt.findFirst({
      where: { payoutId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const verified = latest
      ? await this.gateway.verifyTransfer(latest.reference)
      : null;
    const decision = decideTransferRetry({
      payoutStatus: payout.status,
      offline: payout.transferRecordedBy !== null,
      latestAttempt: latest,
      verified,
      now: new Date(),
    });
    if (decision.action === 'refuse' || decision.action === 'wait')
      throw conflict(decision.message);
    if (decision.action === 'settle' && latest) {
      await this.settleTransferFromGateway(latest.reference, decision.outcome, {
        actor,
        verifiedAmount: verified?.amount,
      });
      return this.store(userId, idempotency, hash, await this.view(id, actor));
    }
    if (decision.action !== 'resubmit' || !latest)
      throw conflict(PAYOUT_MESSAGES.notRetryable);
    const recipientCode = await this.recipientFor(payout);
    const started = { reference: '', attemptId: '' };
    await this.runner.run(
      {
        command: 'payout.retry',
        actor,
        requestRef: payout.requestId,
        guard: null,
      },
      async (ctx) => {
        const locked = await this.lock(ctx, id);
        await this.assertTransferable(ctx.tx, locked);
        // `updatedAt` is the payout's version: only one retry can take it.
        const reference = newTransferReference();
        const claimed = await ctx.tx.payout.updateMany({
          where: {
            id,
            status: payout.status,
            updatedAt: payout.updatedAt,
          },
          data: {
            status: 'processing',
            transferReference: reference,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) throw conflict(PAYOUT_MESSAGES.notRetryable);
        await ctx.tx.transferAttempt.updateMany({
          where: { id: latest.id, status: { not: 'success' } },
          data: {
            status: decision.previous === 'reversed' ? 'reversed' : 'failed',
            failureCode: `verified_${decision.previous}`,
            settledAt: ctx.now,
          },
        });
        const attempt = await ctx.tx.transferAttempt.create({
          data: {
            payoutId: id,
            reference,
            amount: locked.amount,
            status: 'pending',
            submittedAt: ctx.now,
          },
        });
        started.reference = reference;
        started.attemptId = attempt.id;
        ctx.approvals.close('payout', id, 'retried');
        ctx.audit('Payout transfer retried', {
          resourceType: 'payout',
          resourceId: id,
          changes: {
            ...this.change(locked, 'processing', {}),
            previousAttemptId: latest.id,
            previousReference: latest.reference,
            previousGatewayState: verified?.status ?? 'not found',
            reference,
            attemptId: attempt.id,
          },
        });
        return { bumpVersion: false };
      },
    );
    await this.submit(
      actor,
      id,
      started.attemptId,
      started.reference,
      recipientCode,
    );
    return this.store(userId, idempotency, hash, await this.view(id, actor));
  }

  /** `payout.reconcile` (05 §6.5, Q14): a second person confirms an offline transfer, which then becomes `paid`. */
  async reconcilePayout(
    userId: string,
    id: string,
    note: string,
    expectedVersion?: number,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const known = await this.known(id);
    await this.runner.run(
      {
        command: 'payout.reconcile',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payout = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, payout.version);
        if (payout.status !== 'processing' || !payout.transferRecordedBy)
          throw conflict('This offline payout is not awaiting reconciliation.');
        if (payout.transferRecordedBy === userId)
          throw new AppError(403, 'FORBIDDEN', PAYOUT_MESSAGES.reconciler);
        if (!note.trim())
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            PAYOUT_MESSAGES.reconcileNote,
          );
        const claimed = await ctx.tx.payout.updateMany({
          where: {
            id,
            status: 'processing',
            transferRecordedBy: { not: userId },
          },
          data: {
            status: 'paid',
            paidAt: ctx.now,
            reconciledBy: userId,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1)
          throw conflict('This offline payout is not awaiting reconciliation.');
        ctx.approvals.close('payout', id, 'paid');
        ctx.approvals.close('payout_second', id, 'paid');
        ctx.audit('Payout reconciled', {
          resourceType: 'payout',
          resourceId: id,
          note: note.trim(),
          changes: this.change(payout, 'paid', {
            transferRecordedBy: payout.transferRecordedBy,
            reconciledBy: userId,
            transferReference: payout.transferReference,
          }),
        });
        await this.notifyOutcome(ctx, payout, 'paid');
        return { bumpVersion: false };
      },
    );
    return this.view(id, actor);
  }

  /**
   * Applies a transfer state that was verified with Paystack (a signed event,
   * or a retry that found the transfer). The attempt row records what Paystack
   * said. The payout moves only when the attempt is the latest and its amount
   * matches (C-19); a duplicate or out-of-order event writes nothing. `onSettled`
   * runs in the same transaction, so the gateway inbox row closes with the money.
   */
  async settleTransferFromGateway(
    reference: string,
    outcome: TransferOutcome,
    options: {
      actor: ActorContext | null;
      verifiedAmount?: number | null;
      onSettled?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ): Promise<{ applied: boolean }> {
    const attempt = await this.prisma.transferAttempt.findUnique({
      where: { reference },
      include: { payout: { select: { requestId: true } } },
    });
    if (!attempt) return { applied: false };
    let applied = false;
    await this.inTransaction(
      options.actor,
      'payout.gatewaySettled',
      attempt.payout.requestId,
      async (ctx) => {
        const payout = await this.lock(ctx, attempt.payoutId);
        const latest = await ctx.tx.transferAttempt.findFirst({
          where: { payoutId: payout.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        const plan = planTransferEvent({
          outcome,
          attemptId: attempt.id,
          latestAttemptId: latest?.id ?? attempt.id,
          attemptAmount: attempt.amount,
          payoutAmount: payout.amount,
          verifiedAmount: options.verifiedAmount,
        });
        const recorded = await ctx.tx.transferAttempt.updateMany({
          where: { id: attempt.id, status: { not: outcome } },
          data: {
            status: outcome,
            settledAt: ctx.now,
            ...(outcome === 'success' ? { failureCode: null } : {}),
            ...(outcome === 'failed' ? { failureCode: 'gateway_failed' } : {}),
          },
        });
        if (recorded.count === 1) {
          if (plan.payout) {
            const claimed = await ctx.tx.payout.updateMany({
              where: { id: payout.id, status: { in: [...plan.payout.from] } },
              data: {
                status: plan.payout.to,
                version: { increment: 1 },
                ...(outcome === 'success' ? { paidAt: ctx.now } : {}),
              },
            });
            if (claimed.count === 1) {
              applied = true;
              ctx.audit(
                outcome === 'success'
                  ? 'Payout paid'
                  : outcome === 'failed'
                    ? 'Payout transfer failed'
                    : 'Payout transfer reversed',
                {
                  resourceType: 'payout',
                  resourceId: payout.id,
                  changes: this.change(payout, plan.payout.to, {
                    reference,
                    attemptId: attempt.id,
                  }),
                },
              );
              if (outcome === 'success') {
                ctx.approvals.close('payout', payout.id, 'paid');
                ctx.approvals.close('payout_second', payout.id, 'paid');
              } else ctx.approvals.open('payout', payout.id);
              await this.notifyOutcome(
                ctx,
                payout,
                outcome === 'success' ? 'paid' : outcome,
              );
            }
          } else {
            ctx.audit('Transfer event not applied to the payout', {
              resourceType: 'payout',
              resourceId: payout.id,
              changes: {
                reference,
                attemptId: attempt.id,
                outcome,
                reason: plan.reason,
              },
            });
            // A payment confirmed for an attempt that is no longer the latest may mean the provider was paid twice.
            if (outcome === 'success')
              ctx.notify('payout.needs_attention', {
                requestCode: ctx.snap.number,
                amount: Number(attempt.amount),
                detail:
                  plan.reason === 'not_latest'
                    ? 'An earlier transfer attempt was also paid. Check Paystack for a duplicate.'
                    : 'Paystack reports a different amount from the payout. Check it before any retry.',
              });
          }
        }
        await options.onSettled?.(ctx.tx);
        return { bumpVersion: false };
      },
    );
    return { applied };
  }

  /** `GET /providers/me/earnings`: the provider's own payouts with a masked destination and a safe hold reason (05 §10, C-41). */
  async earnings(userId: string, page = 1) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (!profile)
      throw new AppError(
        404,
        'NOT_FOUND',
        'Provider payout history is unavailable.',
      );
    const where = { providerId: profile.id };
    const [items, total, sums, bank] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.payout.count({ where }),
      this.prisma.payout.groupBy({
        by: ['status'],
        where,
        _sum: { amount: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.providerBankAccount.findFirst({
        where: { providerId: profile.id, state: 'verified' },
        orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
        select: { last4: true },
      }),
    ]);
    const sumOf = (include: (status: string) => boolean) =>
      sums
        .filter((row) => include(row.status))
        .reduce((total, row) => total + Number(row._sum?.amount ?? 0n), 0);
    return {
      payouts: items.map((row) => toEarningsItem(row, bank?.last4 ?? null)),
      totalPaid: sumOf((status) => status === 'paid'),
      totalPending: sumOf((status) => !['paid', 'cancelled'].includes(status)),
      total,
      page,
      limit: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
      hasNextPage: page * PAGE_SIZE < total,
      hasPrevPage: page > 1,
    };
  }

  /** The payout side of the 04 §6.17 close guard. Counts only the primary payout: `paid`, or `on_hold` with a recorded reason. */
  async closureState(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<ClosureState> {
    return closureStateOf(
      await tx.payout.findMany({
        where: { requestId },
        select: { kind: true, status: true, holdReason: true },
      }),
    );
  }

  /**
   * `issue.raise` in the defects window (05 §6.6): every unpaid or
   * untransferred payout of the request goes `on_hold` with source `issue`,
   * audited, with its version bumped. A `processing` transfer cannot be
   * stopped, so it is flagged for urgent Finance review instead. Runs in the
   * raising command's transaction; the request row is already locked.
   */
  async holdForIssue(
    ctx: PayoutCreationContext,
    requestId: string,
    issueId: string,
  ): Promise<{ held: string[]; flagged: string[] }> {
    const payouts = await ctx.tx.payout.findMany({
      where: {
        requestId,
        status: {
          in: [
            'pending_approval',
            'awaiting_second_approval',
            'approved',
            'failed',
            'processing',
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const held: string[] = [];
    const flagged: string[] = [];
    for (const payout of payouts) {
      const action = holdAction(payout.status);
      if (!action) continue;
      await this.applyHold(ctx, payout, PAYOUT_MESSAGES.holdIssue, 'issue', {
        issueId,
        sourceEvent: 'issue.raise',
      });
      (action === 'flag' ? flagged : held).push(payout.id);
    }
    return { held, flagged };
  }

  private async applyHold(
    ctx: PayoutCreationContext,
    payout: Payout,
    reason: string,
    source: HoldSource = 'manual',
    extra: Record<string, unknown> = {},
  ) {
    const action = holdAction(payout.status);
    if (!action) throw conflict(PAYOUT_MESSAGES.cannotHold);
    if (action === 'flag') {
      const flagged = await ctx.tx.payout.updateMany({
        where: { id: payout.id, status: 'processing' },
        data: {
          holdReason: reason,
          holdSource: source,
          version: { increment: 1 },
        },
      });
      if (flagged.count !== 1) throw conflict(PAYOUT_MESSAGES.cannotHold);
      ctx.audit('Payout flagged for urgent review', {
        resourceType: 'payout',
        resourceId: payout.id,
        note: reason,
        changes: this.change(payout, 'processing', {
          holdSource: source,
          ...extra,
        }),
      });
      ctx.notify('payout.needs_attention', {
        requestCode: ctx.snap.number,
        amount: Number(payout.amount),
        // new message: not in spec
        detail:
          'It is already with Paystack and cannot be stopped. Reconcile it before any follow-up.',
      });
      return { bumpVersion: false };
    }
    const claimed = await ctx.tx.payout.updateMany({
      where: { id: payout.id, status: payout.status },
      data: {
        status: 'on_hold',
        holdReason: reason,
        holdSource: source,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) throw conflict(PAYOUT_MESSAGES.cannotHold);
    if (payout.status === 'awaiting_second_approval')
      ctx.approvals.close('payout_second', payout.id, 'held');
    // The money item stays visible to Finance while the payout is held (05 §6.6).
    if (payout.status !== 'pending_approval')
      ctx.approvals.open('payout', payout.id);
    ctx.audit('Payout held', {
      resourceType: 'payout',
      resourceId: payout.id,
      note: reason,
      changes: this.change(payout, 'on_hold', { holdSource: source, ...extra }),
    });
    await this.notifyHold(ctx, payout, 'held', source);
    return { bumpVersion: false };
  }

  private async applyRelease(
    ctx: CommandContext,
    payout: PayoutWithApprovals,
    reason: string,
  ) {
    if (payout.status !== 'on_hold') throw conflict(PAYOUT_MESSAGES.notOnHold);
    const facts = await this.bankFacts(ctx, payout.providerId);
    failWith(
      checkRelease({
        issueStatuses: ctx.snap.openIssues.map(({ status }) => status),
        requestHold: ctx.snap.hold?.kind ?? null,
        provider: await this.providerFacts(ctx, payout.providerId),
        holdSource: payout.holdSource,
        pendingBankChange: facts.pendingBankChange,
      }),
    );
    // Earlier sign-offs for other bank details no longer count (C-40); the rows stay, as approvals are immutable.
    const bankVersion = facts.bank ? bankVersionOf(facts.bank) : null;
    const current = new Set(
      currentApprovals(payout.approvals, bankVersion).map(({ id }) => id),
    );
    const invalidated = payout.approvals
      .filter((approval) => !current.has(approval.id))
      .map(({ id }) => id);
    const claimed = await ctx.tx.payout.updateMany({
      where: { id: payout.id, status: 'on_hold' },
      data: {
        status: 'pending_approval',
        holdReason: null,
        holdSource: null,
        version: { increment: 1 },
        ...(facts.bank
          ? { bankAccountId: facts.bank.id, bankLast4: facts.bank.last4 }
          : {}),
      },
    });
    if (claimed.count !== 1) throw conflict(PAYOUT_MESSAGES.notOnHold);
    ctx.approvals.open('payout', payout.id);
    ctx.audit('Payout released', {
      resourceType: 'payout',
      resourceId: payout.id,
      note: reason,
      changes: this.change(payout, 'pending_approval', {
        previousHoldSource: payout.holdSource,
        invalidatedApprovalIds: invalidated,
      }),
    });
    await this.notifyHold(ctx, payout, 'released');
    return { bumpVersion: false };
  }

  private async transferOffline(
    actor: ActorContext,
    userId: string,
    id: string,
    dto: { reference: string; proofFileId: string },
    expectedVersion?: number,
  ) {
    const known = await this.known(id);
    await this.runner.run(
      {
        command: 'payout.transferOffline',
        actor,
        requestRef: known.requestId,
        guard: null,
      },
      async (ctx) => {
        const payout = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, payout.version);
        this.assertApprovedForTransfer(payout);
        await this.assertTransferable(ctx.tx, payout);
        const claimed = await ctx.tx.payout.updateMany({
          where: { id, status: 'approved' },
          data: {
            status: 'processing',
            transferReference: dto.reference,
            transferProofId: dto.proofFileId,
            transferRecordedBy: userId,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1)
          throw conflict(PAYOUT_MESSAGES.notApprovedForTransfer);
        await this.uploads.attach(
          ctx.tx,
          [dto.proofFileId],
          userId,
          'payment_proof',
          'payout',
          id,
        );
        ctx.audit('Payout offline transfer recorded', {
          resourceType: 'payout',
          resourceId: id,
          changes: this.change(payout, 'processing', {
            transferReference: dto.reference,
            proofFileId: dto.proofFileId,
          }),
        });
        return { bumpVersion: false };
      },
    );
    return this.view(id, actor);
  }

  private async transferPaystack(
    actor: ActorContext,
    id: string,
    expectedVersion?: number,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id },
      include: { approvals: true },
    });
    if (!payout) throw notFound();
    assertExpectedVersion(expectedVersion, payout.version);
    this.assertApprovedForTransfer(payout);
    const recipientCode = await this.recipientFor(payout);
    const started = { reference: '', attemptId: '' };
    await this.runner.run(
      {
        command: 'payout.transfer',
        actor,
        requestRef: payout.requestId,
        guard: null,
      },
      async (ctx) => {
        const locked = await this.lock(ctx, id);
        assertExpectedVersion(expectedVersion, locked.version);
        this.assertApprovedForTransfer(locked);
        await this.assertTransferable(ctx.tx, locked);
        const reference = newTransferReference();
        const claimed = await ctx.tx.payout.updateMany({
          where: { id, status: 'approved' },
          data: {
            status: 'processing',
            transferReference: reference,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1)
          throw conflict(PAYOUT_MESSAGES.notApprovedForTransfer);
        const attempt = await ctx.tx.transferAttempt.create({
          data: {
            payoutId: id,
            reference,
            amount: locked.amount,
            status: 'pending',
            submittedAt: ctx.now,
          },
        });
        started.reference = reference;
        started.attemptId = attempt.id;
        ctx.approvals.close('payout', id, 'transfer_started');
        ctx.audit('Payout transfer started', {
          resourceType: 'payout',
          resourceId: id,
          changes: this.change(locked, 'processing', {
            reference,
            attemptId: attempt.id,
            bankLast4: locked.bankLast4,
          }),
        });
        return { bumpVersion: false };
      },
    );
    await this.submit(
      actor,
      id,
      started.attemptId,
      started.reference,
      recipientCode,
    );
    return this.view(id, actor);
  }

  /** The Paystack call, after the claim has committed. Its outcome is recorded in a second transaction. */
  private async submit(
    actor: ActorContext,
    payoutId: string,
    attemptId: string,
    reference: string,
    recipientCode: string,
  ): Promise<void> {
    const payout = await this.prisma.payout.findUniqueOrThrow({
      where: { id: payoutId },
    });
    let result: { transferId?: string; status: string };
    try {
      result = await this.gateway.transfer({
        amount: Number(payout.amount),
        recipientCode,
        reference,
        reason: `XPro provider payout ${payoutId}`,
      });
    } catch (error) {
      await this.recordTransferError(actor, payout, attemptId, error);
      throw error;
    }
    await this.recordSubmitted(actor, payout, attemptId, reference, result);
  }

  private async recordSubmitted(
    actor: ActorContext,
    payout: Payout,
    attemptId: string,
    reference: string,
    result: { transferId?: string; status: string },
  ): Promise<void> {
    let state = classifyGatewayTransfer(result.status);
    if (state === 'failed') {
      // C-43: a synchronous `failed` is confirmed with Paystack before the attempt is closed.
      const confirmed = await this.gateway
        .verifyTransfer(reference)
        .catch(() => null);
      if (!confirmed || classifyGatewayTransfer(confirmed.status) !== 'failed')
        state = 'in_flight';
    }
    await this.inTransaction(
      actor,
      'payout.gatewaySubmitted',
      payout.requestId,
      async (ctx) => {
        await this.lock(ctx, payout.id);
        if (state === 'failed') {
          const failed = await ctx.tx.transferAttempt.updateMany({
            where: { id: attemptId, status: 'pending' },
            data: {
              status: 'failed',
              failureCode: 'gateway_failed',
              settledAt: ctx.now,
              ...(result.transferId
                ? { gatewayTransferId: result.transferId }
                : {}),
            },
          });
          if (failed.count !== 1) return { bumpVersion: false };
          await ctx.tx.payout.updateMany({
            where: { id: payout.id, status: 'processing' },
            data: { status: 'failed', version: { increment: 1 } },
          });
          ctx.approvals.open('payout', payout.id);
          ctx.audit('Payout transfer failed', {
            resourceType: 'payout',
            resourceId: payout.id,
            changes: this.change(payout, 'failed', {
              reference,
              attemptId,
              gatewayStatus: result.status,
            }),
          });
          await this.notifyOutcome(ctx, payout, 'failed');
          return { bumpVersion: false };
        }
        const accepted = await ctx.tx.transferAttempt.updateMany({
          where: { id: attemptId, status: 'pending' },
          data: {
            status: state === 'otp' ? 'otp' : 'processing',
            gatewayTransferId: result.transferId ?? null,
            ...(state === 'otp' ? { failureCode: 'otp_required' } : {}),
          },
        });
        // The signed event may already have settled the attempt.
        if (accepted.count !== 1) return { bumpVersion: false };
        ctx.audit('Payout transfer submitted to Paystack', {
          resourceType: 'payout',
          resourceId: payout.id,
          changes: this.change(payout, 'processing', {
            reference,
            attemptId,
            gatewayStatus: result.status,
          }),
        });
        if (state === 'otp')
          ctx.notify('payout.needs_attention', {
            requestCode: ctx.snap.number,
            amount: Number(payout.amount),
            // new message: not in spec
            detail:
              'Paystack is waiting for an OTP before it sends this transfer. Finish it in the Paystack dashboard.',
          });
        return { bumpVersion: false };
      },
    );
  }

  /**
   * A refusal from Paystack means nothing was created, so the attempt and the
   * payout fail. Any other error (a timeout, a dropped connection, a 5xx)
   * leaves the outcome unknown: the attempt stays `pending`, the payout stays
   * `processing`, and Finance is told to retry, which verifies first.
   */
  private async recordTransferError(
    actor: ActorContext,
    payout: Payout,
    attemptId: string,
    error: unknown,
  ): Promise<void> {
    const refused = error instanceof GatewayRejectedError;
    try {
      await this.inTransaction(
        actor,
        'payout.gatewayFailed',
        payout.requestId,
        async (ctx) => {
          await this.lock(ctx, payout.id);
          if (refused) {
            const failed = await ctx.tx.transferAttempt.updateMany({
              where: { id: attemptId, status: 'pending' },
              data: {
                status: 'failed',
                failureCode: 'gateway_rejected',
                settledAt: ctx.now,
              },
            });
            if (failed.count !== 1) return { bumpVersion: false };
            await ctx.tx.payout.updateMany({
              where: { id: payout.id, status: 'processing' },
              data: { status: 'failed', version: { increment: 1 } },
            });
            ctx.approvals.open('payout', payout.id);
            ctx.audit('Payout transfer refused by Paystack', {
              resourceType: 'payout',
              resourceId: payout.id,
              changes: this.change(payout, 'failed', { attemptId }),
            });
            await this.notifyOutcome(ctx, payout, 'failed');
            return { bumpVersion: false };
          }
          await ctx.tx.transferAttempt.updateMany({
            where: { id: attemptId, status: 'pending' },
            data: { failureCode: 'gateway_unconfirmed' },
          });
          ctx.audit('Payout transfer not confirmed', {
            resourceType: 'payout',
            resourceId: payout.id,
            changes: this.change(payout, 'processing', { attemptId }),
          });
          ctx.notify('payout.needs_attention', {
            requestCode: ctx.snap.number,
            amount: Number(payout.amount),
            // new message: not in spec
            detail:
              'Paystack did not confirm the transfer. Use retry to check it before trying again.',
          });
          return { bumpVersion: false };
        },
      );
    } catch (recordError) {
      this.logger.error(
        `Could not record the gateway transfer error for payout ${payout.id}: ${String(recordError)}`,
      );
    }
  }

  /** The Paystack recipient for the payout's bank, created and stored the first time it is needed. */
  private async recipientFor(payout: PayoutWithApprovals): Promise<string> {
    const bank = payout.bankAccountId
      ? await this.prisma.providerBankAccount.findUnique({
          where: { id: payout.bankAccountId },
        })
      : null;
    this.assertBank(payout, bank);
    if (bank && bank.recipientCodeEnc)
      return decryptSecret(bank.recipientCodeEnc);
    const row = bank!;
    const recipient = await this.gateway.createRecipient({
      name: decryptSecret(row.accountNameEnc),
      accountNumber: decryptSecret(row.accountNumberEnc),
      bankCode: row.bankCode,
    });
    await this.prisma.providerBankAccount.update({
      where: { id: row.id },
      data: { recipientCodeEnc: encryptSecret(recipient.recipientCode) },
    });
    return recipient.recipientCode;
  }

  private async assertTransferable(
    tx: Prisma.TransactionClient,
    payout: PayoutWithApprovals,
  ): Promise<void> {
    const bank = payout.bankAccountId
      ? await tx.providerBankAccount.findUnique({
          where: { id: payout.bankAccountId },
        })
      : null;
    this.assertBank(payout, bank);
  }

  /** The bank on the payout must still be the verified one the approvals covered (05 §6.5: amount and recipient frozen at approval). */
  private assertBank(
    payout: PayoutWithApprovals,
    bank: {
      id: string;
      state: string;
      reviewedAt: Date | null;
      createdAt: Date;
    } | null,
  ): void {
    if (!bank) throw conflict(PAYOUT_MESSAGES.bankDetails);
    if (
      bank.state !== 'verified' ||
      !currentApprovals(payout.approvals, bankVersionOf(bank)).some(
        ({ step }) => step === 1,
      )
    )
      throw conflict(PAYOUT_MESSAGES.bankChangedSinceApproval);
  }

  private assertApprovedForTransfer(payout: Payout): void {
    if (payout.status === 'processing')
      throw conflict(PAYOUT_MESSAGES.transferInProgress);
    if (payout.status !== 'approved')
      throw conflict(PAYOUT_MESSAGES.notApprovedForTransfer);
  }

  private async notifyOutcome(
    ctx: CommandContext,
    payout: Payout,
    outcome: 'paid' | 'failed' | 'reversed',
  ): Promise<void> {
    const provider = await ctx.tx.providerProfile.findUnique({
      where: { id: payout.providerId },
      select: { userId: true },
    });
    const amount = Number(payout.amount);
    if (provider)
      ctx.notify(`payout.${outcome}`, {
        requestCode: ctx.snap.number,
        assignmentId: payout.assignmentId,
        providerUserId: provider.userId,
        amount,
      });
    ctx.notify('payout.finance_update', {
      requestCode: ctx.snap.number,
      amount,
      outcome,
    });
  }

  /** 05 §9: the provider hears of a hold (with a safe reason) and its release; Finance hears of both. */
  private async notifyHold(
    ctx: PayoutCreationContext,
    payout: Payout,
    outcome: 'held' | 'released',
    source: HoldSource = 'manual',
  ): Promise<void> {
    const provider = await ctx.tx.providerProfile.findUnique({
      where: { id: payout.providerId },
      select: { userId: true },
    });
    const reason = safeHoldReason('on_hold', source);
    if (provider && (outcome === 'released' || reason))
      ctx.notify(`payout.${outcome}`, {
        requestCode: ctx.snap.number,
        assignmentId: payout.assignmentId,
        providerUserId: provider.userId,
        ...(outcome === 'held' ? { reason } : {}),
      });
    ctx.notify('payout.finance_update', {
      requestCode: ctx.snap.number,
      amount: Number(payout.amount),
      outcome,
    });
  }

  private async bankFacts(ctx: CommandContext, providerId: string) {
    const bank = await ctx.tx.providerBankAccount.findFirst({
      where: { providerId, state: 'verified' },
      orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const pending = await ctx.tx.providerBankAccount.count({
      where: { providerId, state: 'pending' },
    });
    return { bank, pendingBankChange: pending > 0 };
  }

  private async providerFacts(ctx: CommandContext, providerId: string) {
    const provider = await ctx.tx.providerProfile.findUnique({
      where: { id: providerId },
      select: {
        verification: true,
        reliabilityStatus: true,
        user: { select: { status: true } },
      },
    });
    return {
      userStatus: provider?.user.status ?? null,
      verification: provider?.verification ?? null,
      reliabilityStatus: provider?.reliabilityStatus ?? null,
    };
  }

  /** Request first (the runner), then the payout: the same order everywhere, so concurrent commands queue instead of deadlocking. */
  private async lock(
    ctx: Pick<CommandContext, 'tx'>,
    id: string,
  ): Promise<PayoutWithApprovals> {
    await ctx.tx.$queryRaw(
      Prisma.sql`SELECT id FROM payouts WHERE id = ${id} FOR UPDATE`,
    );
    const payout = await ctx.tx.payout.findUnique({
      where: { id },
      include: { approvals: { orderBy: { createdAt: 'asc' } } },
    });
    if (!payout) throw notFound();
    return payout;
  }

  private async known(id: string): Promise<{ requestId: string }> {
    const row = await this.prisma.payout.findUnique({
      where: { id },
      select: { requestId: true },
    });
    if (!row) throw notFound();
    return row;
  }

  private inTransaction(
    actor: ActorContext | null,
    command: string,
    requestId: string,
    fn: CommandFn,
  ) {
    return actor
      ? this.runner.run(
          { command, actor, requestRef: requestId, guard: null },
          fn,
        )
      : this.runner.runSystem(command, requestId, fn);
  }

  private change(
    payout: Payout,
    after: string,
    extra: Record<string, unknown>,
  ) {
    return {
      before: { status: payout.status, amount: Number(payout.amount) },
      after: { status: after, amount: Number(payout.amount) },
      assignmentId: payout.assignmentId,
      ...extra,
    };
  }

  private async store<T>(
    userId: string,
    idempotency: IdempotencyInput,
    hash: string,
    result: T,
  ): Promise<T> {
    await this.idempotency.store(userId, idempotency.key, hash, 200, result);
    return result;
  }

  private async view(
    id: string,
    actor: ActorContext,
  ): Promise<PayoutQueueItem> {
    const row = await this.prisma.payout.findUniqueOrThrow({ where: { id } });
    return toPayoutDto(
      row,
      actor.staff?.permissions.has('view.pricing') ?? false,
    );
  }
}
