import type { Prisma, UpdateKind } from '@prisma/client';
import { PROGRESS_UPDATE_ENTITY } from '../../uploads/entity-types';
import { closeOpenApprovals } from '../approval-effects';
import type { CommandContext } from '../command-runner';
import {
  blockedReviewDueAt,
  staleEscalationDueAt,
  staleUpdateDueAt,
} from '../domain/execution-timers';
import { cancelOpenScheduleProposals } from '../scheduling/schedule-proposals';

const HOUR_MS = 60 * 60_000;
const T15 = ['T15.stale', 'T15.escalate'] as const;

export type ApprovedUpdate = {
  id: string;
  kind: UpdateKind;
  assignmentId: string;
  issueId: string | null;
};

/** The attached progress evidence of these updates (04 §6.14: `purpose = progress_evidence`). */
export async function hasAttachedEvidence(
  tx: Prisma.TransactionClient,
  updateIds: string[],
): Promise<boolean> {
  if (!updateIds.length) return false;
  const count = await tx.upload.count({
    where: {
      entityType: PROGRESS_UPDATE_ENTITY,
      entityId: { in: updateIds },
      purpose: 'progress_evidence',
      status: 'attached',
    },
  });
  return count > 0;
}

/** 04 §6.14 evidence rule, second half: an approved update of this assignment already carries evidence (REQ-34). */
export async function hasApprovedAssignmentEvidence(
  tx: Prisma.TransactionClient,
  requestId: string,
  assignmentId: string,
): Promise<boolean> {
  const approved = await tx.progressUpdate.findMany({
    where: { requestId, assignmentId, state: 'approved' },
    select: { id: true },
  });
  return hasAttachedEvidence(
    tx,
    approved.map(({ id }) => id),
  );
}

/**
 * The queue item a pending update waits as (02 §6.11): routine updates are
 * `progress`, blocker updates `blocker`, completion reports `completion`.
 * Its id is the update's id.
 */
export function reviewItemKind(
  kind: UpdateKind,
): 'progress' | 'blocker' | 'completion' {
  if (kind === 'blocker') return 'blocker';
  if (kind === 'completion' || kind === 'rework_completion')
    return 'completion';
  return 'progress';
}

function startStaleClock(ctx: CommandContext) {
  ctx.timers.start('T15.stale', staleUpdateDueAt(ctx.now, ctx.settings));
  ctx.timers.start('T15.escalate', staleEscalationDueAt(ctx.now, ctx.settings));
}

/**
 * The 04 §6.14 approval-effects table. `progress.review` (approve) and
 * `progress.addOnBehalf` both run it, so issue resolution, timers and customer
 * notifications cannot drift apart. `userId` is the staff member who approved.
 */
export async function applyApprovedEffects(
  ctx: CommandContext,
  update: ApprovedUpdate,
  userId: string,
): Promise<void> {
  const { kind } = update;
  if (kind === 'start') {
    await ctx.tx.assignment.update({
      where: { id: update.assignmentId },
      data: { workStarted: true },
    });
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: { status: 'in_progress' },
    });
    await cancelOpenScheduleProposals(ctx, ctx.snap.id);
    ctx.timers.stop('T13.noShowCheck');
    // Work began: a no-show check or a schedule change still open is moot.
    await closeOpenApprovals(
      ctx,
      ['no_show', 'schedule_change'],
      'work_started',
    );
    startStaleClock(ctx);
    ctx.notify('progress.started', { requestCode: ctx.snap.number });
  } else if (kind === 'blocker') {
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: { status: 'blocked' },
    });
    ctx.timers.stop([...T15]);
    ctx.timers.start('T16.review', blockedReviewDueAt(ctx.now, ctx.settings));
    ctx.notify('progress.blocker_approved', { requestCode: ctx.snap.number });
  } else if (kind === 'resume') {
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: { status: 'in_progress' },
    });
    ctx.timers.stop('T16.review');
    ctx.approvals.close('blocker', ctx.snap.id, 'resumed');
    startStaleClock(ctx);
    ctx.notify('progress.resumed', { requestCode: ctx.snap.number });
  } else if (kind === 'completion' || kind === 'rework_completion') {
    if (kind === 'rework_completion' && update.issueId)
      await ctx.tx.issue.update({
        where: { id: update.issueId },
        data: {
          status: 'resolved',
          resolvedBy: userId,
          resolvedAt: ctx.now,
          resolvedWith: 'rework',
          evidenceUpdateIds: { push: update.id },
        },
      });
    const hours = Number(ctx.settings['completion.windowHours'] ?? 72);
    const dueAt = new Date(ctx.now.getTime() + hours * HOUR_MS);
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: {
        status: 'completion_pending',
        reportApprovedAt: ctx.now,
        confirmDueAt: dueAt,
      },
    });
    ctx.timers.stop([...T15]);
    ctx.timers.start(
      'T17.reminder24h',
      new Date(ctx.now.getTime() + 24 * HOUR_MS),
    );
    ctx.timers.start(
      'T17.reminder48h',
      new Date(ctx.now.getTime() + 48 * HOUR_MS),
    );
    ctx.timers.start('T17.autoConfirm', dueAt);
    ctx.notify('progress.completion_approved', {
      requestCode: ctx.snap.number,
    });
  } else startStaleClock(ctx);
}
