import type { GuardRegistry } from './allowed-actions';
import {
  accountDenied,
  assertOpen,
  conflict,
  firstFailure,
  invalid,
  isProviderActor,
  isStaffWith,
  objectInput,
  ok,
  staffDenied,
  trimmed,
} from './guards/common';
import type { DomainGuard, GuardResult } from './guards/types';
import type { ActorView, RequestSnapshot } from './snapshot';
import { deriveStage } from './stage';

const DEFAULT_MAX_AUTO_ATTEMPTS = 3;

type AutoInput = { resetAttempts?: unknown; note?: unknown };
type ReviewInput = { approve?: unknown; note?: unknown };
type RespondInput = { accept?: unknown; note?: unknown };
type ShareInput = { fields?: unknown; note?: unknown };

const staffDispatch = (actor: ActorView) =>
  isStaffWith(actor, 'dispatch.manage');

const hasAcceptedQuote = (snap: RequestSnapshot) =>
  snap.quotes.some((quote) => quote.status === 'accepted');

/** 04 §6.6 "Guards for every dispatch command", rows 1 to 4, in table order. */
function dispatchStateChecks(snap: RequestSnapshot): GuardResult {
  return firstFailure(
    assertOpen(snap),
    snap.status === 'under_review' && snap.intake.state === 'approved'
      ? null
      : conflict('Approve the intake before assigning a provider.'),
    snap.currentAssignment
      ? conflict('Withdraw the current offer or assignment before reassigning.')
      : null,
    snap.pendingCancellation
      ? conflict(
          'A cancellation request is waiting. Decide it before assigning a provider.',
        )
      : null,
    snap.customerStanding === 'suspended'
      ? conflict(
          'This customer is suspended. Resolve the suspension before assigning a provider.',
        )
      : null,
  );
}

const auto: DomainGuard<unknown> = (snap, actor, input, _now, settings) => {
  if (actor.kind !== 'system' && !staffDispatch(actor)) return staffDenied();
  const state = dispatchStateChecks(snap);
  if (!state.ok) return state;
  const body = objectInput<AutoInput>(input);
  if (!body) return ok;
  const max = Number(
    settings['assignment.maxAutoAttempts'] ?? DEFAULT_MAX_AUTO_ATTEMPTS,
  );
  if (snap.autoAttempts >= max && body.resetAttempts !== true)
    return conflict(
      `Automatic assignment has used its ${max} offers. Reset the count with a note, or choose a provider.`,
    );
  if (body.resetAttempts === true && !trimmed(body.note))
    return invalid(
      'Add a note explaining why you are resetting automatic assignment.',
    );
  return ok;
};

const offer: DomainGuard<unknown> = (snap, actor) =>
  staffDispatch(actor) ? dispatchStateChecks(snap) : staffDenied();

const cascade: DomainGuard<unknown> = (snap, actor) =>
  actor.kind === 'system' ? dispatchStateChecks(snap) : staffDenied();

// Viewing the ranking makes no offer, so only the intake and open checks apply.
const runs: DomainGuard<unknown> = (snap, actor) => {
  if (!staffDispatch(actor)) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.status === 'under_review' && snap.intake.state === 'approved'
      ? null
      : conflict('Approve the intake before assigning a provider.'),
  );
};

const respond: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isProviderActor(actor)) return accountDenied();
  const current = snap.currentAssignment;
  const body = objectInput<RespondInput>(input);
  return firstFailure(
    assertOpen(snap),
    current?.status === 'offered' &&
      !!actor.userId &&
      actor.userId === snap.currentProviderUserId
      ? null
      : conflict('This offer is no longer awaiting your response.'),
    current && now.getTime() < current.expiresAt.getTime()
      ? null
      : conflict('This offer has expired.'),
    body?.accept === true && snap.providerStanding !== 'active'
      ? invalid('Your profile must be approved and available to accept work.')
      : null,
    body?.accept === false &&
      (trimmed(body.note).length < 3 || trimmed(body.note).length > 500)
      ? invalid('Add a reason for declining.')
      : null,
  );
};

const review: DomainGuard<unknown> = (snap, actor, input) => {
  if (!staffDispatch(actor)) return staffDenied();
  const body = objectInput<ReviewInput>(input);
  return firstFailure(
    assertOpen(snap),
    snap.status === 'under_review' &&
      snap.currentAssignment?.status === 'pending_approval'
      ? null
      : conflict('This assignment is no longer awaiting approval.'),
    body && body.approve === false && trimmed(body.note).length < 3
      ? invalid('Explain why the assignment is not confirmed.')
      : null,
  );
};

// 04 §5.2 #14: `under_review` offers and, with no accepted quote, an accepted
// provider in `matched` or `quoted`.
const withdraw: DomainGuard<unknown> = (snap, actor, input) => {
  if (!staffDispatch(actor)) return staffDenied();
  const current = snap.currentAssignment;
  const withdrawable =
    !!current &&
    (current.status === 'offered' ||
      current.status === 'pending_approval' ||
      current.status === 'accepted');
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    withdrawable && hasAcceptedQuote(snap)
      ? conflict(
          'This provider has an accepted quote. Replace the provider instead.',
        )
      : null,
    withdrawable && ['under_review', 'matched', 'quoted'].includes(snap.status)
      ? null
      : conflict('This offer is no longer current.'),
    body && !trimmed(body.note)
      ? invalid('Add a note for withdrawing this offer.')
      : null,
  );
};

// new message: not in spec
const REPLACE_STAGE_MESSAGE =
  "This provider can't be replaced at this stage of the job.";
// new message: not in spec
const REPLACE_BLOCKED_MESSAGE =
  "This provider can't be replaced while the job is blocked.";
const REPLACE_STATUSES = new Set([
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'blocked',
]);

// 04 §5.2 #21 and §6.19. Every `blocked` request is held, blocked by the
// provider (an approved blocker) or has an open issue; the three are listed so
// the rule reads like the spec.
function replaceBlockedRule(snap: RequestSnapshot, now: Date): boolean {
  return (
    Boolean(snap.hold) ||
    snap.openIssues.length > 0 ||
    deriveStage(snap, now) === 'blocked_provider'
  );
}

const replace: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!staffDispatch(actor)) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    snap.currentAssignment?.status === 'accepted'
      ? null
      : conflict('This provider is no longer assigned to the request.'),
    hasAcceptedQuote(snap)
      ? null
      : conflict('Create or accept a quote before replacing this provider.'),
    REPLACE_STATUSES.has(snap.status) ? null : conflict(REPLACE_STAGE_MESSAGE),
    snap.status !== 'blocked' || replaceBlockedRule(snap, now)
      ? null
      : conflict(REPLACE_BLOCKED_MESSAGE),
    body && !trimmed(body.note)
      ? invalid('Add a note explaining why this provider is being replaced.')
      : null,
  );
};

const shareDetails: DomainGuard<unknown> = (snap, actor, input) => {
  if (!staffDispatch(actor)) return staffDenied();
  const body = objectInput<ShareInput>(input);
  const sharesSiteDetails =
    Array.isArray(body?.fields) &&
    body.fields.some((field) => field === 'address' || field === 'access');
  return firstFailure(
    assertOpen(snap),
    snap.currentAssignment?.status === 'accepted'
      ? null
      : conflict('Confirm a provider assignment before sharing job details.'),
    body &&
      sharesSiteDetails &&
      snap.currentSchedule?.status !== 'confirmed' &&
      !trimmed(body.note)
      ? invalid(
          'Add a note explaining why the provider needs the site details before the date is confirmed.',
        )
      : null,
  );
};

const setMode: DomainGuard<unknown> = (snap, actor, input) => {
  if (!staffDispatch(actor)) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    body && trimmed(body.note).length < 5
      ? invalid('Add a note explaining the change.')
      : null,
  );
};

export const DISPATCH_GUARDS: GuardRegistry = {
  'dispatch.setMode': setMode,
  'dispatch.runs': runs,
  'dispatch.cascade': cascade,
  'assignment.auto': auto,
  'assignment.offer': offer,
  'assignment.respond': respond,
  'assignment.review': review,
  'assignment.withdraw': withdraw,
  'assignment.replace': replace,
  'request.shareDetails': shareDetails,
};
