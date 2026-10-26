import { TimerKinds } from '../../platform/timers/timer-kinds';
import type { CommandContext } from '../command-runner';
import { reviewItemKind } from '../execution/progress-effects';
import { autoConfirmRestart } from '../domain/cancellation-rules';
import {
  closeRequestApprovals,
  MONEY_APPROVAL_KINDS,
} from '../approval-effects';

/**
 * Ends the accepted assignment on a cancelled request (04 §6.21): the
 * provider loses access, the assignment keeps its `workStarted` flag so
 * compensation can still be decided under 05 §6.4. Returns the ended
 * assignments so the caller can notify each provider.
 */
export async function endAcceptedAssignments(
  ctx: CommandContext,
  endedBy: string | null,
): Promise<Array<{ id: string; providerUserId: string }>> {
  const accepted = await ctx.tx.assignment.findMany({
    where: { requestId: ctx.snap.id, status: 'accepted' },
    select: { id: true, providerUserId: true },
  });
  if (!accepted.length) return [];
  await ctx.tx.assignment.updateMany({
    where: { id: { in: accepted.map(({ id }) => id) }, status: 'accepted' },
    data: {
      status: 'withdrawn',
      endReason: 'request_cancelled',
      endedAt: ctx.now,
      endedBy,
    },
  });
  return accepted;
}

/**
 * Auto-rejects the pending progress updates of an assignment that is ending (04 §6.14, §6.18):
 * `systemReason = assignment_ended` and the review timers stop. Without `assignmentId` it
 * rejects every pending update on the request (cancellation). Returns the rejected ids.
 */
export async function rejectPendingUpdates(
  ctx: CommandContext,
  assignmentId?: string,
  systemReason = 'assignment_ended',
): Promise<string[]> {
  const pending = await ctx.tx.progressUpdate.findMany({
    where: {
      requestId: ctx.snap.id,
      state: 'pending',
      ...(assignmentId ? { assignmentId } : {}),
    },
    select: { id: true, kind: true },
  });
  if (!pending.length) return [];
  const ids = pending.map(({ id }) => id);
  await ctx.tx.progressUpdate.updateMany({
    where: { id: { in: ids }, state: 'pending' },
    data: { state: 'rejected', systemReason, reviewedAt: ctx.now },
  });
  for (const { id, kind } of pending)
    ctx.approvals.close(reviewItemKind(kind), id, systemReason);
  return ids;
}

const OPEN_OFFER_STATUSES = ['offered', 'pending_approval'] as const;
const LIVE_SCHEDULE_STATUSES = [
  'proposed',
  'confirmed',
  'changes_requested',
] as const;
/** Issue note kept on rows closed by a cancellation; the enum has no `cancelled` outcome, so they resolve as `no_rework`. */
export const ISSUE_CANCELLED_NOTE = 'Closed because the request was cancelled.';

/**
 * Everything an approved cancellation leaves behind (04 §6.18, §6.21, D-17), shared
 * by `cancellation.decide` approve and the staff direct cancel. It doesn't move the
 * request status or open refunds; the caller does that. Returns the assignments
 * with `workStarted` (the compensation candidates, 04 §4.7) and the providers
 * whose accepted assignment ended.
 */
export async function cleanupCancelledRequest(
  ctx: CommandContext,
  actorUserId: string | null,
): Promise<{
  compensationCandidateIds: string[];
  ended: Array<{ id: string; providerUserId: string }>;
}> {
  const { tx, snap, now } = ctx;
  const started = await tx.assignment.findMany({
    where: { requestId: snap.id, workStarted: true },
    select: { id: true },
  });
  await tx.assignment.updateMany({
    where: { requestId: snap.id, status: { in: [...OPEN_OFFER_STATUSES] } },
    data: {
      status: 'withdrawn',
      endedAt: now,
      endedBy: actorUserId,
      endReason: 'request_cancelled',
    },
  });
  const ended = await endAcceptedAssignments(ctx, actorUserId);
  // A hold must not survive: releaseHold would restore `previousStatus` on a cancelled request.
  await tx.serviceRequest.update({
    where: { id: snap.id },
    data: {
      holdKind: null,
      holdBy: null,
      holdReason: null,
      holdAt: null,
      holdPreviousStatus: null,
    },
  });
  await tx.issue.updateMany({
    where: {
      requestId: snap.id,
      status: { in: ['open', 'rework', 'disputed'] },
    },
    data: {
      status: 'resolved',
      resolvedBy: actorUserId,
      resolvedAt: now,
      resolvedWith: 'no_rework',
      resolution: ISSUE_CANCELLED_NOTE,
    },
  });
  await rejectPendingUpdates(ctx);
  await tx.schedule.updateMany({
    where: { requestId: snap.id, status: { in: [...LIVE_SCHEDULE_STATUSES] } },
    data: { status: 'cancelled' },
  });
  ctx.timers.stop(Object.values(TimerKinds));
  await closeRequestApprovals(ctx, 'request_cancelled', MONEY_APPROVAL_KINDS);
  return {
    compensationCandidateIds: started.map(({ id }) => id),
    ended,
  };
}

/**
 * T17 after a rejected or withdrawn cancellation (FX-3.10 follow-up): auto-confirm
 * refuses while a cancellation is pending, so its timer is spent by now. Only a
 * `completion_pending` request has a customer response to wait for.
 */
export async function restartAutoConfirm(ctx: CommandContext): Promise<void> {
  if (ctx.snap.status !== 'completion_pending') return;
  const row = await ctx.tx.serviceRequest.findUnique({
    where: { id: ctx.snap.id },
    select: { confirmDueAt: true, reportApprovedAt: true },
  });
  const restart = row ? autoConfirmRestart(row, ctx.now) : null;
  if (!restart) return;
  for (const reminder of restart.reminders)
    ctx.timers.start(reminder.kind, reminder.dueAt);
  ctx.timers.start(TimerKinds.T17AutoConfirm, restart.autoConfirmAt);
}
