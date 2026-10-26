import type { UpdateKind } from '@prisma/client';
import { conflict, invalid } from './guards/common';
import type { GuardFailure } from './guards/types';
import { watClock } from './schedule-checks';
import type { RequestStatus } from './statuses';

export type ProgressInputStatus =
  'in_progress' | 'blocked' | 'completion_pending';

export const PROGRESS_INPUT_STATUSES: ReadonlyArray<ProgressInputStatus> = [
  'in_progress',
  'blocked',
  'completion_pending',
];

export const PROGRESS_PAUSED_MESSAGE =
  'XPro has paused this job. Message XPro Dispatch before continuing.';
export const PROGRESS_NOT_OPEN_MESSAGE =
  'This job is not open for execution updates.';
export const PROGRESS_STALE_MESSAGE =
  'This update no longer fits the current job status. Reject it instead.';
export const PROGRESS_ISSUE_PENDING_MESSAGE =
  'XPro is resolving the issue reported at completion. You can update the job once it is resolved.';

const EARLY_START_MS = 2 * 60 * 60_000;

export function deriveProgressKind(input: {
  status: ProgressInputStatus;
  requestStatus: RequestStatus;
  issueStatus?: 'open' | 'rework' | 'disputed' | 'resolved';
  issueId?: string;
}): UpdateKind | null {
  if (input.status === 'blocked' && input.requestStatus === 'in_progress')
    return 'blocker';
  if (input.status === 'in_progress') {
    if (input.requestStatus === 'scheduled') return 'start';
    if (input.requestStatus === 'blocked') return 'resume';
    if (input.requestStatus !== 'in_progress') return null;
    if (input.issueStatus === 'rework' && input.issueId) return 'rework';
    if (input.issueStatus === 'rework') return null;
    return 'progress';
  }
  if (
    input.status === 'completion_pending' &&
    input.requestStatus === 'in_progress'
  ) {
    if (input.issueStatus === 'rework' && input.issueId)
      return 'rework_completion';
    if (input.issueStatus === 'rework') return null;
    return 'completion';
  }
  return null;
}

export function progressEvidenceSatisfied(input: {
  hasCurrentAttachments: boolean;
  hasApprovedCurrentAssignmentEvidence: boolean;
}): boolean {
  return (
    input.hasCurrentAttachments || input.hasApprovedCurrentAssignmentEvidence
  );
}

export type ProgressAddCheckInput = {
  /** Raw body value; anything outside the three statuses fails the first row. */
  status: unknown;
  note: unknown;
  issueId?: string | null;
  requestStatus: RequestStatus;
  /** The current assignment is held and `accepted`. */
  assignmentAccepted: boolean;
  /** `startAt` of the current assignment's confirmed schedule, if there is one. */
  confirmedStartAt: Date | null;
  onHold: boolean;
  /** Every issue of the request that is not `resolved`. */
  unresolvedIssues: ReadonlyArray<{
    id: string;
    status: 'open' | 'rework' | 'disputed' | 'resolved';
  }>;
  hasCurrentAttachments: boolean;
  hasApprovedCurrentAssignmentEvidence: boolean;
  /** Kinds of this assignment's updates still `pending`. */
  pendingKinds: ReadonlyArray<UpdateKind>;
  now: Date;
  /** `progress.addOnBehalf` skips the early-start and one-pending rows (04 §6.14). */
  staffOverride?: boolean;
};

export type ProgressAddCheck =
  | {
      ok: true;
      kind: UpdateKind;
      /** The rework issue the update is linked to; null for every other kind. */
      issueId: string | null;
      /** A blocker replaces these pending routine updates (Q-def-12). */
      replacesPending: boolean;
    }
  | GuardFailure;

const REPLACEABLE_BY_BLOCKER: ReadonlyArray<UpdateKind> = [
  'start',
  'progress',
  'resume',
  'rework',
];

/**
 * The 04 §6.14 `progress.add` check table, row by row and in order. The
 * service loads the rows it needs; this function decides.
 */
export function checkProgressAdd(
  input: ProgressAddCheckInput,
): ProgressAddCheck {
  const status = input.status as ProgressInputStatus;
  if (!PROGRESS_INPUT_STATUSES.includes(status))
    return invalid('Choose a valid update type.');
  if (!input.assignmentAccepted)
    return conflict('Accept the current assignment before updating this job.');
  if (!input.confirmedStartAt)
    return conflict('Confirm the schedule before starting work.');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 3 || note.length > 2000)
    return invalid('Add a progress note.');
  if (!['scheduled', 'in_progress', 'blocked'].includes(input.requestStatus))
    return conflict(PROGRESS_NOT_OPEN_MESSAGE);
  if (input.onHold) return conflict(PROGRESS_PAUSED_MESSAGE);
  if (
    input.unresolvedIssues.some(
      ({ status: issue }) => issue === 'open' || issue === 'disputed',
    )
  )
    return conflict(PROGRESS_ISSUE_PENDING_MESSAGE);
  const unresolvedRework = input.unresolvedIssues.find(
    ({ status: issue }) => issue === 'rework',
  );
  const reworkApplies =
    !!unresolvedRework &&
    input.requestStatus === 'in_progress' &&
    status !== 'blocked';
  if (reworkApplies && input.issueId !== unresolvedRework.id)
    return conflict('Link this update to the issue you are fixing.');
  const rework = reworkApplies ? unresolvedRework : undefined;
  const kind = deriveProgressKind({
    status,
    requestStatus: input.requestStatus,
    issueStatus: rework ? 'rework' : undefined,
    issueId: rework?.id,
  });
  if (
    kind === 'start' &&
    !input.staffOverride &&
    input.now.getTime() < input.confirmedStartAt.getTime() - EARLY_START_MS
  )
    return conflict(
      `You can start this job from ${watClock(new Date(input.confirmedStartAt.getTime() - EARLY_START_MS))} WAT.`,
    );
  if (status === 'blocked' && kind !== 'blocker')
    return conflict('Start the job before reporting a blocker.');
  if (status === 'completion_pending' && !kind)
    return conflict('Resume or start work before reporting completion.');
  if (!kind) return conflict(PROGRESS_NOT_OPEN_MESSAGE);
  if (
    (kind === 'completion' || kind === 'rework_completion') &&
    !progressEvidenceSatisfied({
      hasCurrentAttachments: input.hasCurrentAttachments,
      hasApprovedCurrentAssignmentEvidence:
        input.hasApprovedCurrentAssignmentEvidence,
    })
  )
    return conflict('Attach work evidence before reporting completion.');
  let replacesPending = false;
  if (!input.staffOverride && input.pendingKinds.length) {
    replacesPending =
      kind === 'blocker' &&
      input.pendingKinds.every((item) => REPLACEABLE_BY_BLOCKER.includes(item));
    if (!replacesPending)
      return conflict('Wait for XPro to review your previous update.');
  }
  return {
    ok: true,
    kind,
    issueId: rework?.id ?? null,
    replacesPending,
  };
}
