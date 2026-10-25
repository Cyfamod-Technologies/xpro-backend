import type { GuardRegistry } from './allowed-actions';
import {
  accountDenied,
  assertOpen,
  conflict,
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
import type { ActorView, RequestSnapshot } from './snapshot';

export { assertOpen } from './guards/common';

const PAYMENT_WINDOW_MS = 30 * 60_000;
const PAUSED_MESSAGE =
  'XPro has paused this job. Message XPro Dispatch before continuing.';
const NOT_OPEN_FOR_UPDATES = 'This job is not open for execution updates.';
const ACKNOWLEDGEMENT_REQUIRED =
  'Customer acknowledgement is required before final closure.';
const CANNOT_BE_CANCELLED = 'This request can no longer be cancelled.';
const NOT_AWAITING_DECISION =
  'This cancellation request is no longer awaiting a decision.';
// new message: not in spec
const CLOSE_WITH_CANCELLATION =
  'A cancellation request is waiting. Decide it before closing.';

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

const scheduleStatusFailure = (snap: RequestSnapshot): GuardResult => {
  if (snap.status === 'ready_to_schedule' || snap.status === 'scheduled')
    return ok;
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

const scheduleRespond: DomainGuard<unknown> = (snap, actor) => {
  const party = scheduleParty(snap, actor);
  if (!party) return accountDenied();
  const schedule = snap.currentSchedule;
  return firstFailure(
    assertOpen(snap),
    schedule?.status === 'proposed'
      ? null
      : conflict('This schedule is no longer awaiting confirmation.'),
    schedule?.[party] === 'pending'
      ? null
      : conflict('Your response has already been recorded.'),
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

const progressAdd: DomainGuard<unknown> = (snap, actor) => {
  if (!isCurrentProvider(snap, actor)) return accountDenied();
  return firstFailure(
    assertOpen(snap),
    snap.status === 'blocked' && snap.hold ? conflict(PAUSED_MESSAGE) : null,
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status)
      ? null
      : conflict(NOT_OPEN_FOR_UPDATES),
  );
};

const progressReview: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'progress.review')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.pendingUpdates.length > 0
      ? null
      : conflict('This update is no longer awaiting review.'),
  );
};

const progressAddOnBehalf: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'progress.review')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status)
      ? null
      : conflict(NOT_OPEN_FOR_UPDATES),
    snap.hold ? conflict(PAUSED_MESSAGE) : null,
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

// Whether the confirmed date has passed needs `hold.previousStatus`, which the
// snapshot does not carry; HoldsService checks it (04 §6.15 second check).
const releaseHold: DomainGuard<unknown> = (snap, actor) => {
  if (!holdOrRelease(actor)) return staffDenied();
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
      : conflict('This no-show decision is stale.'),
  );
};

const noshowCorrect: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'dispatch.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.latestNoShow?.status === 'confirmed'
      ? null
      : conflict('This no-show cannot be corrected.'),
  );
};

const awaitingCustomerConfirmation = (snap: RequestSnapshot): GuardResult =>
  snap.status === 'completion_pending' && !snap.openIssues.length
    ? ok
    : conflict(ACKNOWLEDGEMENT_REQUIRED);

const completionRespond: DomainGuard<unknown> = (snap, actor) => {
  if (!isOwner(snap, actor)) return accountDenied();
  return firstFailure(assertOpen(snap), awaitingCustomerConfirmation(snap));
};

const completionConfirmOnBehalf: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  return firstFailure(assertOpen(snap), awaitingCustomerConfirmation(snap));
};

const issueRaise: DomainGuard<unknown> = (snap, actor, _input, now) => {
  if (!isOwner(snap, actor)) return accountDenied();
  return firstFailure(
    assertOpen(snap),
    snap.status === 'acknowledged' &&
      snap.defectsWindowEndsAt &&
      now < snap.defectsWindowEndsAt
      ? null
      : conflict('The defects window has ended.'),
  );
};

const issueAccept: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.openIssues.some((item) => item.status === 'open')
      ? null
      : conflict('This issue is no longer awaiting review.'),
  );
};

const issueOpen: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'issue.resolve')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.openIssues.length > 0
      ? null
      : conflict('This issue is no longer open.'),
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
      ? conflict(
          'Add a reason to close this request before the defects window ends.',
        )
      : null,
  );
};

const cancellationRequest: DomainGuard<unknown> = (snap, actor) => {
  if (!isOwner(snap, actor)) return accountDenied();
  return firstFailure(
    CANCELLABLE_STATUSES.has(snap.status)
      ? null
      : conflict(CANNOT_BE_CANCELLED),
    snap.pendingCancellation
      ? conflict('Your cancellation request is already awaiting XPro.')
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

const cancellationDecide: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isStaffWith(actor, 'request.cancel')) return staffDenied();
  const info = snap.pendingCancellationInfo;
  const body = objectInput<{ approve?: unknown; note?: unknown }>(input);
  return firstFailure(
    CANCELLABLE_STATUSES.has(snap.status)
      ? null
      : conflict(CANNOT_BE_CANCELLED),
    snap.pendingCancellation ? null : conflict(NOT_AWAITING_DECISION),
    (info?.paid || info?.workStarted) &&
      !isStaffWith(actor, 'request.cancel.active')
      ? staffDenied()
      : null,
    body && body.approve === false && !trimmed(body.note)
      ? invalid('Add a reason for rejecting this cancellation request.')
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
  'issue.resolve': issueOpen,
  'issue.accept': issueAccept,
  'issue.escalate': issueOpen,
  'request.close': requestClose,
  'cancellation.request': cancellationRequest,
  'cancellation.withdraw': cancellationWithdraw,
  'cancellation.decide': cancellationDecide,
};
