import { isFreshPendingAttempt } from '../../payments/domain/pending-attempt';
import type { GuardRegistry } from './allowed-actions';
import {
  accountDenied,
  conflict,
  firstFailure,
  invalid,
  isOwner,
  isStaffWith,
  objectInput,
  paymentInProgress,
  staffDenied,
  trimmed,
} from './guards/common';
import type { DomainGuard } from './guards/types';
import type { RequestSnapshot } from './snapshot';

const NOT_AWAITING_PAYMENT = 'This quote is no longer awaiting payment.';
const NOT_AWAITING_RECONCILIATION =
  'This payment is not awaiting reconciliation.';

const awaitingPayment = (snap: RequestSnapshot) =>
  snap.status === 'awaiting_payment' && snap.latestQuote?.status === 'accepted';

const initiate: DomainGuard<unknown> = (snap, actor, _input, now) => {
  if (!isOwner(snap, actor)) return accountDenied();
  return firstFailure(
    awaitingPayment(snap) ? null : conflict(NOT_AWAITING_PAYMENT),
    isFreshPendingAttempt(snap.payment.pendingPaymentAt, now)
      ? paymentInProgress(
          'A payment is already in progress. Check its status before trying again.',
        )
      : null,
  );
};

const recordOffline: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'payment.record')) return staffDenied();
  const body = objectInput<{ proofFileId?: unknown }>(input);
  return firstFailure(
    awaitingPayment(snap) ? null : conflict(NOT_AWAITING_PAYMENT),
    body && !trimmed(body.proofFileId)
      ? invalid('Attach proof of the payment before recording it.')
      : null,
  );
};

// PaymentsService re-checks the payment row (offline, `recorded`, other recorder).
// Reconcile has no state check on the request: money already received is
// settled even after the quote lapsed or the request was cancelled, and the
// late-payment branch opens the full refund (05 §6.2, §7).
const reconcile: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'payment.record')) return staffDenied();
  const body = objectInput<{ note?: unknown }>(input);
  return firstFailure(
    snap.payment.offlineRecorded ? null : conflict(NOT_AWAITING_RECONCILIATION),
    body && !trimmed(body.note) ? invalid('Add a reconciliation note.') : null,
  );
};

const rejectOffline: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'payment.record')) return staffDenied();
  const body = objectInput<{ reason?: unknown }>(input);
  return firstFailure(
    snap.payment.offlineRecorded ? null : conflict(NOT_AWAITING_RECONCILIATION),
    body && !trimmed(body.reason)
      ? invalid('Add a reason for rejecting this payment.')
      : null,
  );
};

export const PAYMENT_GUARDS: GuardRegistry = {
  'payment.initiate': initiate,
  'payment.recordOffline': recordOffline,
  'payment.reconcile': reconcile,
  'payment.rejectOffline': rejectOffline,
};
