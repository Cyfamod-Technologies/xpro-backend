import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SYSTEM_ACTOR } from '../../platform/actor/actor.types';
import { AppError } from '../../platform/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import {
  closeRequestApprovals,
  endAcceptedAssignments,
} from '../cancellation/cancellation-cleanup';
import { RequestCommandRunner } from '../command-runner';
import { cancellationRefundsResolved } from '../../payments/domain/refund-rules';

export type AfterCommit = () => Promise<void>;

export type HoursConflict = { scheduleId: string; requestId: string };

const OFFER_STATUSES = ['offered', 'pending_approval'] as const;
const LIVE_STATUSES = ['offered', 'pending_approval', 'accepted'] as const;
const PAYMENT_TIMERS = [
  'T9.reminder24h',
  'T9.reminder72h',
  'T9.lapse',
] as const;

/**
 * Domain events that move a request: money settling and provider changes.
 * Every transition runs through the command runner, so it bumps the version,
 * writes an audit row and dispatches notifications like any other command.
 * Methods that take a `tx` join the caller's transaction; the caller invokes
 * the returned `afterCommit()` once its own transaction has committed.
 */
@Injectable()
export class RequestEventsService {
  private readonly logger = new Logger(RequestEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RequestCommandRunner,
  ) {}

  /**
   * A payment for the accepted quote was marked paid in `tx`. Moves the
   * request to `ready_to_schedule` and stops the T9 timers. A payment that
   * arrives after the request left `awaiting_payment` leaves the request
   * alone and opens a full refund for Finance instead.
   */
  async onPaymentSettled(
    tx: Prisma.TransactionClient,
    requestId: string,
    quoteId: string,
    paymentId: string,
  ): Promise<{ settled: boolean; afterCommit: AfterCommit }> {
    let settled = false;
    const outcome = await this.runner.runInTx(
      tx,
      {
        command: 'payment.settled',
        actor: SYSTEM_ACTOR,
        requestRef: requestId,
        // 05 event: a late payment must still settle (refund) on a terminal request, so no state guard.
        guard: null,
      },
      async (ctx) => {
        const payment = await ctx.tx.payment.findUnique({
          where: { id: paymentId },
        });
        const quote = await ctx.tx.quote.findUnique({ where: { id: quoteId } });
        if (!payment || !quote) throw notFound();
        ctx.timers.stop([...PAYMENT_TIMERS], quoteId);
        ctx.timers.stop('payment.pendingCheck', paymentId);
        if (
          ctx.snap.status !== 'awaiting_payment' ||
          quote.status !== 'accepted'
        ) {
          if (!payment.lateRefundOpened) {
            await ctx.tx.refund.create({
              data: {
                paymentId,
                requestId,
                amount: payment.amount,
                status: 'pending_approval',
                reason:
                  'Late payment received after the request was no longer awaiting payment.',
                requestedBy: 'system',
              },
            });
            await ctx.tx.payment.update({
              where: { id: paymentId },
              data: { lateRefundOpened: true },
            });
          }
          ctx.audit('Late payment received', {
            changes: { paymentId, reference: payment.reference },
          });
          ctx.notify('payment.late', {
            requestCode: ctx.snap.number,
            reference: payment.reference,
          });
          return { bumpVersion: false };
        }
        settled = true;
        await ctx.tx.serviceRequest.update({
          where: { id: requestId },
          data: { status: 'ready_to_schedule' },
        });
        ctx.audit('Request paid', {
          changes: { paymentId, reference: payment.reference },
        });
        ctx.notify('payment.settled_customer', {
          requestCode: ctx.snap.number,
        });
        ctx.notify('payment.settled_provider', {
          requestCode: ctx.snap.number,
        });
        // 04 §6.12: schedule.manage holders get `Paid — schedule it`, and 02 §6.11 opens the `schedule_needed` item.
        ctx.notify('payment.settled_staff', { requestCode: ctx.snap.number });
        ctx.approvals.open('schedule_needed', ctx.snap.id);
      },
    );
    return { settled, afterCommit: outcome.afterCommit };
  }

  /**
   * Called inside the transaction that completed or waived a refund. When
   * every refund of the cancellation is `completed` or `waived` (a rejected or
   * failed one that Finance replaced does not count), the cancellation
   * completes and a `cancelling` request becomes `cancelled`: the customer and
   * provider are told, the remaining accepted assignment ends and every open
   * approval item for the request closes (04 §5.2 #37, §6.21).
   */
  async onRefundsResolved(
    tx: Prisma.TransactionClient,
    cancellationId: string,
  ): Promise<{ resolved: boolean; afterCommit: AfterCommit }> {
    const noop = { resolved: false, afterCommit: () => Promise.resolve() };
    const cancellation = await tx.cancellation.findUnique({
      where: { id: cancellationId },
      select: { requestId: true },
    });
    if (!cancellation) return noop;
    const refunds = await tx.refund.findMany({
      where: { cancellationId },
      select: { paymentId: true, status: true, createdAt: true },
    });
    if (!cancellationRefundsResolved(refunds)) return noop;
    const outcome = await this.runner.runInTx(
      tx,
      {
        command: 'refunds.resolved',
        actor: SYSTEM_ACTOR,
        requestRef: cancellation.requestId,
        // 05 event: refund settlement must pass assertOpen's `cancelling` freeze.
        guard: null,
      },
      async (ctx) => {
        await ctx.tx.cancellation.updateMany({
          where: { id: cancellationId, status: 'approved' },
          data: { status: 'completed' },
        });
        if (ctx.snap.status !== 'cancelling') return { changed: false };
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'cancelled' },
        });
        const ended = await endAcceptedAssignments(ctx, null);
        ctx.audit('Request cancelled (refunds resolved)', {
          changes: {
            cancellationId,
            endedAssignmentIds: ended.map(({ id }) => id),
          },
        });
        ctx.notify('cancellation.completed_customer', {
          requestCode: ctx.snap.number,
        });
        for (const assignment of ended)
          ctx.notify('cancellation.completed_provider', {
            requestCode: ctx.snap.number,
            assignmentId: assignment.id,
            providerUserId: assignment.providerUserId,
          });
        await closeRequestApprovals(ctx, 'request_cancelled');
      },
    );
    return { resolved: outcome.changed, afterCommit: outcome.afterCommit };
  }

  /**
   * The provider can no longer take work (suspended, delisted, restricted).
   * Withdraws their open offers, sending each request back to dispatch, puts
   * payouts for their accepted jobs on hold and tells staff about those jobs
   * (04 §6.19). Runs one command per affected request, each with its own audit
   * row, so it is not one transaction. No suspend, delist or restrict command
   * calls it yet; today only a rejected verification does (providers.service).
   */
  async onProviderStandingChanged(
    providerId: string,
    reason: string,
  ): Promise<void> {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!profile) return;
    const requestIds = new Set<string>();
    const failures: unknown[] = [];
    await this.withdrawOffers(
      providerId,
      reason,
      OFFER_STATUSES,
      'Provider offer withdrawn (standing changed)',
      requestIds,
      failures,
    );
    const accepted = await this.prisma.assignment.findMany({
      where: { providerId, status: 'accepted' },
      select: { id: true, requestId: true },
    });

    for (const assignment of accepted)
      await this.attempt(requestIds, failures, assignment.requestId, () =>
        this.runner.runSystem(
          'provider.standingChanged',
          assignment.requestId,
          async (ctx) => {
            const current = await ctx.tx.assignment.findFirst({
              where: { id: assignment.id, providerId, status: 'accepted' },
              select: { id: true },
            });
            if (!current) return { changed: false };
            await ctx.tx.payout.updateMany({
              where: {
                assignmentId: assignment.id,
                status: {
                  in: [
                    'pending_approval',
                    'awaiting_second_approval',
                    'approved',
                  ],
                },
              },
              data: {
                status: 'on_hold',
                holdReason: reason,
                holdSource: 'suspension',
              },
            });
            ctx.audit('Provider standing changed on an accepted job', {
              changes: { providerId, reason },
            });
            ctx.notify('request.provider_standing_changed', {
              requestCode: ctx.snap.number,
              reason,
            });
            return { bumpVersion: false };
          },
        ),
      );

    await this.prisma.auditLog.create({
      data: {
        actorType: 'system',
        entityType: 'provider_profile',
        entityId: providerId,
        action: 'Provider standing changed',
        metadata: { reason, affectedRequestIds: [...requestIds] },
      },
    });
    if (failures.length) throw failures[0];
  }

  /**
   * The provider turned availability off. 03 §6.3: availability only gates new
   * offers, so this withdraws their `offered` offers and nothing else; offers
   * awaiting staff review, accepted jobs and payouts are left alone.
   */
  async onProviderUnavailable(providerId: string): Promise<void> {
    const requestIds = new Set<string>();
    const failures: unknown[] = [];
    await this.withdrawOffers(
      providerId,
      'Provider turned availability off.',
      ['offered'],
      'Provider offer withdrawn (availability off)',
      requestIds,
      failures,
    );
    if (failures.length) throw failures[0];
  }

  /** Not called yet: no command suspends a customer account (01). Add the call when one exists. */
  async onCustomerSuspended(userId: string): Promise<void> {
    const requests = await this.prisma.serviceRequest.findMany({
      where: {
        ownerId: userId,
        status: { notIn: ['closed', 'cancelled', 'rejected'] },
      },
      select: { id: true },
    });
    for (const request of requests)
      await this.runner.runSystem(
        'customer.suspended',
        request.id,
        (ctx) => {
          ctx.notify('request.customer_suspended', {
            requestCode: ctx.snap.number,
          });
          return Promise.resolve();
        },
        { bumpVersion: false },
      );
  }

  /**
   * New working hours or time off clash with proposed schedules. Each one
   * goes to `changes_requested` so staff can re-propose. Runs after the
   * provider's calendar transaction has committed.
   */
  async onProviderHoursChanged(
    providerId: string,
    conflicts: ReadonlyArray<HoursConflict>,
  ): Promise<void> {
    for (const conflict of conflicts)
      await this.runner.runSystem(
        'provider.hoursChanged',
        conflict.requestId,
        async (ctx) => {
          const schedule = await ctx.tx.schedule.findFirst({
            where: {
              id: conflict.scheduleId,
              requestId: ctx.snap.id,
              providerId,
              status: 'proposed',
            },
            select: { id: true },
          });
          if (!schedule) return { changed: false };
          await ctx.tx.schedule.update({
            where: { id: schedule.id },
            data: {
              status: 'changes_requested',
              responses: { push: 'Provider: working hours changed' },
            },
          });
          ctx.audit('Schedule changes requested (provider hours changed)', {
            resourceType: 'schedule',
            resourceId: schedule.id,
            changes: { providerId },
          });
        },
      );
  }

  private async attempt(
    requestIds: Set<string>,
    failures: unknown[],
    requestId: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    requestIds.add(requestId);
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Provider standing change failed for request ${requestId}: ${String(error)}`,
      );
      failures.push(error);
    }
  }

  /**
   * Withdraws the provider's open offers in the given statuses, one command
   * per request. An offer that is the request's only live assignment sends the
   * request back to dispatch: a cascade in auto mode, a staff notice otherwise.
   * `provider_suspended` is the only end reason for a provider-side withdrawal.
   */
  private async withdrawOffers(
    providerId: string,
    reason: string,
    statuses: ReadonlyArray<'offered' | 'pending_approval'>,
    auditAction: string,
    requestIds: Set<string>,
    failures: unknown[],
  ): Promise<void> {
    const offers = await this.prisma.assignment.findMany({
      where: { providerId, status: { in: [...statuses] } },
      select: { requestId: true },
    });
    for (const requestId of new Set(offers.map((offer) => offer.requestId)))
      await this.attempt(requestIds, failures, requestId, () =>
        this.runner.runSystem(
          'provider.standingChanged',
          requestId,
          async (ctx) => {
            const open = await ctx.tx.assignment.findMany({
              where: {
                providerId,
                requestId: ctx.snap.id,
                status: { in: [...statuses] },
              },
              include: { request: { select: { dispatchMode: true } } },
            });
            if (!open.length) return { changed: false };
            for (const assignment of open) {
              await ctx.tx.assignment.update({
                where: { id: assignment.id },
                data: {
                  status: 'withdrawn',
                  endReason: 'provider_suspended',
                  endedAt: ctx.now,
                  response: reason,
                },
              });
              ctx.timers.stop(
                ['T1.reminder', 'T1.expire', 'T3.review'],
                assignment.id,
              );
              const hasOther = await ctx.tx.assignment.findFirst({
                where: {
                  requestId: ctx.snap.id,
                  id: { not: assignment.id },
                  status: { in: [...LIVE_STATUSES] },
                },
                select: { id: true },
              });
              if (hasOther) continue;
              const auto = assignment.request.dispatchMode === 'auto';
              await ctx.tx.serviceRequest.update({
                where: { id: ctx.snap.id },
                data: {
                  status: 'under_review',
                  needsAssignmentReason: auto ? null : 'provider_suspended',
                },
              });
              // DispatchTrigger has no provider_standing_changed value, so the run records a plain cascade.
              if (auto) ctx.enqueueCascade('cascade');
              else
                ctx.notify('request.needs_manual_assignment', {
                  requestCode: ctx.snap.number,
                });
            }
            ctx.audit(auditAction, { changes: { providerId, reason } });
          },
        ),
      );
  }
}

function notFound() {
  return new AppError(
    404,
    'NOT_FOUND',
    'This request is no longer available to your account.',
  );
}
