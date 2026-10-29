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
import { quoteItemsTotal } from './quote-items';
import type { RequestSnapshot } from './snapshot';

const PAYMENT_WINDOW_MS = 30 * 60_000;

const PAID_MESSAGE = 'This job is paid. Change the price through a variation.';
const NOT_AWAITING_APPROVAL = 'This quote is not awaiting approval.';
const QUOTE_GONE = 'This quote version no longer exists.';

const COSTING_STATUSES = new Set([
  'matched',
  'quoted',
  'awaiting_payment',
  'scheduled',
]);
const SELLABLE_STATUSES = new Set(['sent', 'accepted']);
const DRAFT_STATUSES = new Set(['matched', 'quoted', 'awaiting_payment']);

type ItemsInput = { items?: unknown };
type PublishInput = {
  pricingOverrideNote?: unknown;
  customerNote?: unknown;
};
type RespondInput = { decision?: unknown; note?: unknown };

const acceptedAssignment = (snap: RequestSnapshot) =>
  snap.currentAssignment?.status === 'accepted';

/** 04 §6.10: after a replacement the accepted quote carries `providerChangedAt` and the new provider costs the job. */
const costingOpen = (snap: RequestSnapshot) =>
  snap.status === 'ready_to_schedule'
    ? snap.quotes.some(
        (quote) => quote.status === 'accepted' && quote.providerChangedAt,
      )
    : COSTING_STATUSES.has(snap.status);

const itemsFailure = (input: unknown): GuardResult => {
  const body = objectInput<ItemsInput>(input);
  if (!body) return ok;
  const total = quoteItemsTotal(body.items);
  return total.ok ? ok : total;
};

const draftAwaitingApproval = (snap: RequestSnapshot): GuardResult => {
  const latest = snap.latestQuote;
  return latest?.status === 'draft' && latest.approvalRequestedAt
    ? ok
    : conflict(NOT_AWAITING_APPROVAL);
};

/** The state checks shared by `quote.publish` and `quote.approve` (04 §6.11 publish table). */
const publishStateChecks = (snap: RequestSnapshot, now: Date): GuardResult => {
  if (!acceptedAssignment(snap))
    return conflict(
      'Confirm a provider assignment before publishing the quote.',
    );
  if (snap.payment.paid) return conflict(PAID_MESSAGE);
  if (
    snap.payment.pendingPaymentAt &&
    now.getTime() - snap.payment.pendingPaymentAt.getTime() < PAYMENT_WINDOW_MS
  )
    return paymentInProgress(
      'A payment is in progress for the current quote. Try again once it settles.',
    );
  return ok;
};

const contribute: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isCurrentProvider(snap, actor)) return accountDenied();
  return firstFailure(
    assertOpen(snap),
    acceptedAssignment(snap)
      ? null
      : conflict('Accept the current assignment before updating this job.'),
    costingOpen(snap)
      ? null
      : conflict("Costing can't change once work has started."),
    itemsFailure(input),
  );
};

const save: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'quote.manage')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    snap.payment.paid ? conflict(PAID_MESSAGE) : null,
    DRAFT_STATUSES.has(snap.status)
      ? null
      : conflict('Quotes can only be prepared once a provider is confirmed.'),
    acceptedAssignment(snap)
      ? null
      : // new message: not in spec
        conflict('Confirm a provider assignment before preparing a quote.'),
    itemsFailure(input),
  );
};

const publish: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isStaffWith(actor, 'quote.manage')) return staffDenied();
  const body = objectInput<PublishInput>(input);
  return firstFailure(
    assertOpen(snap),
    publishStateChecks(snap, now),
    body && !snap.providerCostingSubmitted && !trimmed(body.pricingOverrideNote)
      ? conflict(
          "Get the provider's costing first, or add a pricing override note.",
        )
      : null,
    body && snap.status === 'awaiting_payment' && !trimmed(body.customerNote)
      ? invalid('Add a note for the customer explaining the new version.')
      : null,
  );
};

const approve: DomainGuard<unknown> = (snap, actor, _input, now) => {
  if (!isStaffWith(actor, 'quote.approve')) return staffDenied();
  return firstFailure(
    assertOpen(snap),
    draftAwaitingApproval(snap),
    publishStateChecks(snap, now),
  );
};

const returnQuote: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'quote.approve')) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    draftAwaitingApproval(snap),
    body && !trimmed(body.note)
      ? invalid('Add a note explaining what to change.')
      : null,
  );
};

const respond: DomainGuard<unknown> = (snap, actor, input, now) => {
  if (!isOwner(snap, actor)) return accountDenied();
  const body = objectInput<RespondInput>(input);
  const decision = body?.decision;
  const sent = snap.latestSentQuote;
  return firstFailure(
    assertOpen(snap),
    body &&
      decision !== 'accepted' &&
      decision !== 'revision_requested' &&
      decision !== 'declined'
      ? invalid('Choose accept, decline or request a revision.')
      : null,
    sent && snap.status === 'quoted'
      ? null
      : conflict('This quote has already changed or received a response.'),
    sent?.validUntil && now < sent.validUntil
      ? null
      : conflict('This quote has expired. XPro will send you a new one.'),
    body && decision !== 'accepted' && !trimmed(body.note)
      ? invalid('Explain the decline or revision request.')
      : null,
    decision === 'declined' && snap.pendingCancellation
      ? conflict('Your cancellation request is already awaiting XPro.')
      : null,
  );
};

const setPayout: DomainGuard<unknown> = (snap, actor, input) => {
  if (
    !isStaffWith(actor, 'quote.manage') ||
    !isStaffWith(actor, 'view.pricing')
  )
    return staffDenied();
  const body = objectInput<{ amount?: unknown }>(input);
  return firstFailure(
    assertOpen(snap),
    snap.quotes.some((quote) => SELLABLE_STATUSES.has(quote.status))
      ? null
      : conflict(QUOTE_GONE),
    acceptedAssignment(snap)
      ? null
      : // new message: not in spec
        conflict('Confirm a provider assignment before setting the payout.'),
    body && !(Number.isSafeInteger(body.amount) && Number(body.amount) > 0)
      ? invalid(
          'Enter a payout amount above 0 and no higher than the quote total.',
        )
      : null,
  );
};

export const PRICING_GUARDS: GuardRegistry = {
  'quote.contribute': contribute,
  'quote.save': save,
  'quote.publish': publish,
  'quote.approve': approve,
  'quote.return': returnQuote,
  'quote.respond': respond,
  'quote.setPayout': setPayout,
};
