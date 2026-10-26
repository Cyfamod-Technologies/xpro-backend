import type { GuardRegistry } from './allowed-actions';
import { CANCELLATION_REASON_CODES, workStartedOn } from './cancellation-rules';
import { canFreeCancel } from './intake-guards';
import {
  accountDenied,
  assertOpen,
  conflict,
  fail,
  firstFailure,
  invalid,
  isCurrentProvider,
  isOwner,
  isStaffWith,
  objectInput,
  ok,
  paymentInProgress,
  staffDenied,
  trimmed,
} from './guards/common';
import type { DomainGuard, GuardResult } from './guards/types';
import {
  PROGRESS_INPUT_STATUSES,
  PROGRESS_ISSUE_PENDING_MESSAGE,
  PROGRESS_NOT_OPEN_MESSAGE,
  PROGRESS_PAUSED_MESSAGE,
  PROGRESS_STALE_MESSAGE,
} from './progress-rules';
import type { ActorView, RequestSnapshot } from './snapshot';

export { assertOpen } from './guards/common';

const PAYMENT_WINDOW_MS = 30 * 60_000;
const ACKNOWLEDGEMENT_REQUIRED =
  'Customer acknowledgement is required before final closure.';
const EXPLAIN_UNRESOLVED_ISSUE = 'Explain the unresolved issue.';
// 02 §6.10 gives this message.
const ESCALATION_NOTE_REQUIRED = 'Add a note explaining the escalation.';
// new message: not in spec
const CANNOT_BE_CANCELLED = 'This request can no longer be cancelled.';
// new message: not in spec
const NOT_AWAITING_DECISION =
  'This cancellation request is no longer awaiting a decision.';
// new message: not in spec
const CLOSE_WITH_CANCELLATION =
  'A cancellation request is waiting. Decide it before closing.';
// new message: not in spec
const EARLY_CLOSE_REASON =
  'Add a reason to close this request before the defects window ends.';
// new message: not in spec
const CANCEL_NOTE_REQUIRED = 'Add a reason for cancelling this request.';
// new message: not in spec
const CANCEL_REASON_REQUIRED = 'Choose a reason for cancelling this request.';
// new message: not in spec
const CANCEL_DECIDE_FIRST =
  'A cancellation request is waiting. Decide it instead.';
// new message: not in spec
const REJECT_CANCELLATION_REASON =
  'Add a reason for rejecting this cancellation request.';
// new message: not in spec
const NOSHOW_DECISION_STALE = 'This no-show decision is stale.';
// new message: not in spec
const NOSHOW_NOT_CORRECTABLE = 'This no-show cannot be corrected.';
// new message: not in spec
const DEFECTS_WINDOW_ENDED = 'The defects window has ended.';
// new message: not in spec
const EXPLAIN_ISSUE = 'Explain the issue.';
// new message: not in spec
const ISSUE_NOT_AWAITING_REVIEW = 'This issue is no longer awaiting review.';
// new message: not in spec
const ISSUE_NOT_OPEN = 'This issue is no longer open.';
// new message: not in spec
const ISSUE_DECISION_REASON = 'Add a reason for this issue decision.';
// new message: not in spec
const DISPUTE_NEEDS_SUPER_ADMIN = 'A super admin must decide this dispute.';

const EXECUTION_STATUSES = new Set([
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
]);

/** 04 §5.2 #12 and #24: the statuses a cancellation can be requested in or decided from. */
export const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set([
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
]);

const scheduleParty = (snap: RequestSnapshot, actor: ActorView) =>
  isOwner(snap, actor)
    ? ('customer' as const)
    : isCurrentProvider(snap, actor)
      ? ('provider' as const)
      : null;

const pendingPaymentWithinWindow = (snap: RequestSnapshot, now: Date) =>
  snap.payment.pendingPaymentAt !== null &&
  now.getTime() - snap.payment.pendingPaymentAt.getTime() < PAYMENT_WINDOW_MS;

/** 04 §6.13: a hold that started before work (`previousStatus = scheduled`) still lets staff move the date. */
const heldBeforeWork = (snap: RequestSnapshot) =>
  snap.status === 'blocked' &&
  !!snap.hold &&
  snap.hold.previousStatus === 'scheduled';

const acceptsSchedules = (snap: RequestSnapshot) =>
  snap.status === 'ready_to_schedule' ||
  snap.status === 'scheduled' ||
  heldBeforeWork(snap);

const scheduleStatusFailure = (snap: RequestSnapshot): GuardResult => {
  if (acceptsSchedules(snap)) return ok;
  if (snap.status === 'awaiting_payment')
    return conflict(
      "The customer hasn't paid yet. Schedule once payment is received.",
    );
  if (EXECUTION_STATUSES.has(snap.status))
    return conflict('This job has already entered execution.');
  return conflict(
    'An accepted quote and provider assignment are required for scheduling.',
  );
};

// 04 §6.13 propose table, in order. The date, hours and overlap rows need the
// provider's calendar, so SchedulesService runs them (checkScheduleInterval).
const schedulePropose: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'schedule.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    scheduleStatusFailure(snap),
    snap.replacementPayoutPending
      ? conflict("Set the new provider's payout before scheduling.")
      : null,
    snap.providerStanding && snap.providerStanding !== 'active'
      ? conflict(
          'This provider is suspended. Replace them or wait for reactivation.',
        )
      : null,
  );
};

// 04 §6.13 respond table, in order. The second-confirmation re-check needs the
// provider's calendar and standing, so SchedulesService runs it.
const scheduleRespond: DomainGuard<unknown> = (snap, actor, input) => {
  const party = scheduleParty(snap, actor);
  if (!party) return accountDenied();
  const schedule = snap.currentSchedule;
  const body = objectInput<{ accept?: unknown; note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    schedule?.status === 'proposed' && acceptsSchedules(snap)
      ? null
      : conflict('This schedule is no longer awaiting confirmation.'),
    schedule?.[party] === 'pending'
      ? null
      : conflict('Your response has already been recorded.'),
    body && body.accept === false && !trimmed(body.note)
      ? invalid('Explain your requested schedule change.')
      : null,
  );
};

const scheduleRequestChange: DomainGuard<unknown> = (snap, actor) => {
  if (!scheduleParty(snap, actor)) return accountDenied();
  return firstFailure(
    assertOpen(snap),
    snap.currentSchedule?.status === 'confirmed'
      ? null
      : conflict('This schedule is no longer confirmed.'),
  );
};

const notAcceptedYet = () =>
  conflict('Accept the current assignment before updating this job.');

const noteLengthOk = (value: unknown) => {
  const length = trimmed(value).length;
  return length >= 3 && length <= 2000;
};

const issueBlocksProgress = (snap: RequestSnapshot) =>
  snap.openIssues.some(
    ({ status }) => status === 'open' || status === 'disputed',
  );

// 04 §6.14 check table rows 1, 2, 4, 5, 6 and 7, in order. The schedule, link,
// early-start, evidence and pending-update rows read rows the snapshot lacks,
// so checkProgressAdd runs them in the service.
const progressAdd: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isCurrentProvider(snap, actor)) return accountDenied();
  const body = objectInput<{ status?: unknown; note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    body && !PROGRESS_INPUT_STATUSES.includes(body.status as 'in_progress')
      ? invalid('Choose a valid update type.')
      : null,
    snap.currentAssignment?.status === 'accepted' ? null : notAcceptedYet(),
    body && !noteLengthOk(body.note) ? invalid('Add a progress note.') : null,
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status)
      ? null
      : conflict(PROGRESS_NOT_OPEN_MESSAGE),
    snap.hold ? conflict(PROGRESS_PAUSED_MESSAGE) : null,
    issueBlocksProgress(snap) ? conflict(PROGRESS_ISSUE_PENDING_MESSAGE) : null,
  );
};

// 04 §6.14 review table. The assignment, fit, evidence and suspended rows read
// the update's own rows, so ProgressService runs them.
const progressReview: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'progress.review')) return staffDenied();
  const body = objectInput<{ approve?: unknown; note?: unknown }>(input);
  const approving = body?.approve === true;
  return firstFailure(
    assertOpen(snap),
    snap.pendingUpdates.length > 0
      ? null
      : conflict('This update is no longer awaiting review.'),
    body && body.approve === false && !trimmed(body.note)
      ? invalid('Explain why the update is not approved.')
      : null,
    // 04 §6.17: no completion approval while an issue is disputed.
    approving && snap.openIssues.some(({ status }) => status === 'disputed')
      ? conflict(PROGRESS_STALE_MESSAGE)
      : null,
    approving && snap.hold ? conflict(PROGRESS_PAUSED_MESSAGE) : null,
  );
};

// 04 §6.14 on-behalf: the add table's state rows without the early-start and
// one-pending rows (checkProgressAdd runs the rest).
const progressAddOnBehalf: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'progress.review')) return staffDenied();
  const body = objectInput<{
    status?: unknown;
    note?: unknown;
    reportedVia?: unknown;
  }>(input);
  return firstFailure(
    assertOpen(snap),
    body && !PROGRESS_INPUT_STATUSES.includes(body.status as 'in_progress')
      ? invalid('Choose a valid update type.')
      : null,
    snap.currentAssignment?.status === 'accepted' ? null : notAcceptedYet(),
    body && trimmed(body.reportedVia).length < 3
      ? invalid('Add how the provider reported this update.')
      : null,
    body && !noteLengthOk(body.note) ? invalid('Add a progress note.') : null,
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status)
      ? null
      : conflict(PROGRESS_NOT_OPEN_MESSAGE),
    snap.hold ? conflict(PROGRESS_PAUSED_MESSAGE) : null,
    issueBlocksProgress(snap) ? conflict(PROGRESS_ISSUE_PENDING_MESSAGE) : null,
  );
};

const holdOrRelease = (actor: ActorView) =>
  isStaffWith(actor, 'progress.review', 'dispatch.manage');

const hold: DomainGuard<unknown> = (snap, actor, input) => {
  if (!holdOrRelease(actor)) return staffDenied();
  const body = objectInput<{ reason?: unknown }>(input);
  const reason = trimmed(body?.reason);
  return firstFailure(
    assertOpen(snap),
    ['scheduled', 'in_progress'].includes(snap.status)
      ? null
      : conflict(
          'Only a scheduled job or work in progress can be put on hold.',
        ),
    body && (reason.length < 5 || reason.length > 500)
      ? invalid('Add a reason for pausing this job.')
      : null,
  );
};

const confirmedScheduleOf = (snap: RequestSnapshot) =>
  snap.currentSchedule?.status === 'confirmed'
    ? snap.currentSchedule
    : snap.replacedSchedule?.status === 'confirmed'
      ? snap.replacedSchedule
      : null;

const releaseHold: DomainGuard<unknown> = (snap, actor, _input, now) => {
  if (!holdOrRelease(actor)) return staffDenied();
  const confirmed = confirmedScheduleOf(snap);
  return firstFailure(
    assertOpen(snap),
    snap.status === 'blocked' && snap.hold
      ? null
      : conflict("This job isn't on hold."),
    snap.providerStanding === 'suspended'
      ? conflict(
          'This provider is suspended. Replace them or wait for reactivation.',
        )
      : null,
    snap.hold?.previousStatus === 'scheduled' &&
      confirmed &&
      confirmed.endAt < now
      ? conflict(
          'The confirmed date has passed. Propose a new date before releasing the hold.',
        )
      : null,
  );
};

const noshowRecord: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'dispatch.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.currentSchedule?.status === 'confirmed'
      ? null
      : conflict('This schedule is no longer confirmed.'),
  );
};

const noshowDecide: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'dispatch.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.latestNoShow?.status === 'open'
      ? null
      : conflict(NOSHOW_DECISION_STALE),
  );
};

const noshowCorrect: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'dispatch.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.latestNoShow?.status === 'confirmed'
      ? null
      : conflict(NOSHOW_NOT_CORRECTABLE),
  );
};

const awaitingCustomerConfirmation = (snap: RequestSnapshot): GuardResult =>
  snap.status === 'completion_pending' && !snap.openIssues.length
    ? ok
    : conflict(ACKNOWLEDGEMENT_REQUIRED);

const completionRespond: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isOwner(snap, actor)) return accountDenied();
  const body = objectInput<{ acknowledge?: unknown; note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    awaitingCustomerConfirmation(snap),
    body && body.acknowledge === false && !trimmed(body.note)
      ? invalid(EXPLAIN_UNRESOLVED_ISSUE)
      : null,
  );
};

const completionConfirmOnBehalf: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  return firstFailure(assertOpen(snap), awaitingCustomerConfirmation(snap));
};

const issueRaise: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isOwner(snap, actor)) return accountDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    snap.status === 'acknowledged' &&
      snap.defectsWindowEndsAt &&
      now < snap.defectsWindowEndsAt
      ? null
      : conflict(DEFECTS_WINDOW_ENDED),
    body && !trimmed(body.note) ? invalid(EXPLAIN_ISSUE) : null,
  );
};

const issueAccept: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.openIssues.some((item) => item.status === 'open')
      ? null
      : conflict(ISSUE_NOT_AWAITING_REVIEW),
  );
};

// The issue id is a path parameter, so the service finds the row; the snapshot
// says whether any issue is in a state this outcome can act on.
const issueResolve: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  const body = objectInput<{ outcome?: unknown; note?: unknown }>(input);
  const disputing = body?.outcome === 'dispute_decision';
  const states: ReadonlyArray<string> = disputing
    ? ['disputed']
    : body
      ? ['open', 'rework']
      : ['open', 'rework', 'disputed'];
  return firstFailure(
    assertOpen(snap),
    snap.openIssues.some(({ status }) => states.includes(status))
      ? null
      : conflict(ISSUE_NOT_OPEN),
    body && !trimmed(body.note) ? invalid(ISSUE_DECISION_REASON) : null,
    disputing && !actor.isSuperAdmin
      ? fail(403, 'FORBIDDEN', DISPUTE_NEEDS_SUPER_ADMIN)
      : null,
  );
};

const issueEscalate: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    snap.openIssues.length > 0 ? null : conflict(ISSUE_NOT_OPEN),
    body && trimmed(body.note).length < 5
      ? invalid(ESCALATION_NOTE_REQUIRED)
      : null,
  );
};

// The payout check (04 §5.2 #36) reads payout rows, so ClosureService keeps it.
const requestClose: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isStaffWith(actor, 'request.close')) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    snap.status === 'acknowledged' && !snap.openIssues.length
      ? null
      : conflict(ACKNOWLEDGEMENT_REQUIRED),
    snap.pendingCancellation ? conflict(CLOSE_WITH_CANCELLATION) : null,
    body &&
      snap.defectsWindowEndsAt &&
      snap.defectsWindowEndsAt > now &&
      !trimmed(body.note)
      ? conflict(EARLY_CLOSE_REASON)
      : null,
  );
};

/** Transition #6 lets staff cancel a `submitted` request too; the customer's own request path starts at #12. */
const STAFF_CANCELLABLE: ReadonlySet<string> = new Set([
  'submitted',
  ...CANCELLABLE_STATUSES,
]);

const cancelNoteLength = (value: unknown) => trimmed(value).length;

/** `request.cancel` for staff (04 §2.1, §5.2 #6, #12, #24): `request.cancel.active` once the job is paid or work started. */
const staffCancel: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isStaffWith(actor, 'request.cancel')) return staffDenied();
  const body = objectInput<{ note?: unknown; reasonCode?: unknown }>(input);
  const started = snap.payment.paid || workStartedOn(snap);
  return firstFailure(
    STAFF_CANCELLABLE.has(snap.status) ? null : conflict(CANNOT_BE_CANCELLED),
    started && !isStaffWith(actor, 'request.cancel.active')
      ? staffDenied()
      : null,
    snap.pendingCancellation ? conflict(CANCEL_DECIDE_FIRST) : null,
    body &&
      !CANCELLATION_REASON_CODES.includes(
        body.reasonCode as (typeof CANCELLATION_REASON_CODES)[number],
      )
      ? invalid(CANCEL_REASON_REQUIRED)
      : null,
    body &&
      (cancelNoteLength(body.note) < 5 || cancelNoteLength(body.note) > 1000)
      ? invalid(CANCEL_NOTE_REQUIRED)
      : null,
    body && !snap.payment.paid && pendingPaymentWithinWindow(snap, now)
      ? paymentInProgress('A payment is still processing. Try again shortly.')
      : null,
  );
};

/**
 * One `request.cancel` key for both callers of `POST /requests/:id/cancel`:
 * the owner's free cancel, or a staff member's direct cancel. A customer who can
 * no longer cancel for free uses `cancellation.request` instead.
 */
const requestCancel: DomainGuard<unknown> = (
  snap,
  actor,
  input,
  now,
  settings,
) => {
  if (isOwner(snap, actor))
    return canFreeCancel(snap, actor, input, now, settings);
  if (actor.kind === 'staff')
    return staffCancel(snap, actor, input, now, settings);
  return accountDenied();
};

const cancellationRequest: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isOwner(snap, actor)) return accountDenied();
  const body = objectInput<{ note?: unknown; reasonCode?: unknown }>(input);
  return firstFailure(
    CANCELLABLE_STATUSES.has(snap.status)
      ? null
      : conflict(CANNOT_BE_CANCELLED),
    snap.pendingCancellation
      ? conflict('Your cancellation request is already awaiting XPro.')
      : null,
    body &&
      (cancelNoteLength(body.note) < 5 || cancelNoteLength(body.note) > 1000)
      ? invalid(CANCEL_NOTE_REQUIRED)
      : null,
  );
};

const cancellationWithdraw: DomainGuard<unknown> = (snap, actor) => {
  if (!isOwner(snap, actor)) return accountDenied();
  return snap.pendingCancellation &&
    (snap.pendingCancellationInfo?.requestedBy ?? 'customer') === 'customer'
    ? ok
    : conflict(NOT_AWAITING_DECISION);
};

/**
 * Approve is limited to #12 and #24. Reject is also allowed in `acknowledged` so
 * staff can clear a cancellation that was pending when the customer confirmed;
 * 04 §6.17 and §7 don't refuse the confirmation itself (only T17 refuses).
 */
const cancellationDecide: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isStaffWith(actor, 'request.cancel')) return staffDenied();
  const info = snap.pendingCancellationInfo;
  const body = objectInput<{ approve?: unknown; note?: unknown }>(input);
  const rejectOnly = snap.status === 'acknowledged';
  return firstFailure(
    CANCELLABLE_STATUSES.has(snap.status) ||
      (rejectOnly && body?.approve !== true)
      ? null
      : conflict(CANNOT_BE_CANCELLED),
    snap.pendingCancellation ? null : conflict(NOT_AWAITING_DECISION),
    (info?.paid || info?.workStarted) &&
      !isStaffWith(actor, 'request.cancel.active')
      ? staffDenied()
      : null,
    body && body.approve === false && !trimmed(body.note)
      ? invalid(REJECT_CANCELLATION_REASON)
      : null,
    body && body.approve === true && pendingPaymentWithinWindow(snap, now)
      ? paymentInProgress('A payment is still processing. Try again shortly.')
      : null,
  );
};

export const LIFECYCLE_GUARDS: GuardRegistry = {
  'schedule.propose': schedulePropose,
  'schedule.respond': scheduleRespond,
  'schedule.requestChange': scheduleRequestChange,
  'progress.add': progressAdd,
  'progress.review': progressReview,
  'progress.addOnBehalf': progressAddOnBehalf,
  'request.hold': hold,
  'request.releaseHold': releaseHold,
  'noshow.record': noshowRecord,
  'noshow.confirm': noshowDecide,
  'noshow.dismiss': noshowDecide,
  'noshow.correct': noshowCorrect,
  'completion.respond': completionRespond,
  'completion.confirmOnBehalf': completionConfirmOnBehalf,
  'issue.raise': issueRaise,
  'issue.resolve': issueResolve,
  'issue.accept': issueAccept,
  'issue.escalate': issueEscalate,
  'request.close': requestClose,
  'request.cancel': requestCancel,
  'cancellation.request': cancellationRequest,
  'cancellation.withdraw': cancellationWithdraw,
  'cancellation.decide': cancellationDecide,
};
