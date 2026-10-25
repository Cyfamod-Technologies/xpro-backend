import { PAYMENT_GUARDS } from './payment-guards';
import {
  check,
  customer,
  failure,
  HOUR,
  NOW,
  provider,
  quote,
  snapshot,
  staff,
} from './guard.testkit';
import type { RequestSnapshot } from './snapshot';

const awaitingPayment = (overrides: Partial<RequestSnapshot> = {}) =>
  snapshot({
    status: 'awaiting_payment',
    intake: { state: 'approved' },
    latestQuote: quote('accepted'),
    quotes: [quote('accepted')],
    ...overrides,
  });
const finance = staff('payment.record');
const NOT_AWAITING = failure(
  409,
  'STATE_CONFLICT',
  'This quote is no longer awaiting payment.',
);
const NOT_RECONCILABLE = failure(
  409,
  'STATE_CONFLICT',
  'This payment is not awaiting reconciliation.',
);
const pendingAt = (minutesAgo: number, offlineRecorded = false) => ({
  paid: false,
  pendingPaymentAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  offlineRecorded,
});
const recordedAt = (minutesAgo: number) => pendingAt(minutesAgo, true);

describe('payment.initiate (05 §6.1)', () => {
  const initiate = (snap = awaitingPayment(), actor = customer()) =>
    check(PAYMENT_GUARDS, 'payment.initiate', snap, actor);

  it('passes for the owner on an accepted quote awaiting payment', () => {
    expect(initiate()).toEqual({ ok: true });
  });

  it('is only for the request owner', () => {
    expect(initiate(awaitingPayment(), customer('customer-2'))).toMatchObject({
      status: 403,
      message: 'This action is not available for your account type.',
    });
    expect(initiate(awaitingPayment(), provider() as never)).toMatchObject({
      status: 403,
    });
    expect(initiate(awaitingPayment(), finance as never)).toMatchObject({
      status: 403,
    });
  });

  it('refuses when the quote is no longer awaiting payment', () => {
    expect(initiate(awaitingPayment({ status: 'quoted' }))).toEqual(
      NOT_AWAITING,
    );
    expect(
      initiate(awaitingPayment({ latestQuote: quote('expired') })),
    ).toEqual(NOT_AWAITING);
    expect(initiate(awaitingPayment({ status: 'ready_to_schedule' }))).toEqual(
      NOT_AWAITING,
    );
  });

  it('refuses a second attempt within 30 minutes', () => {
    expect(initiate(awaitingPayment({ payment: pendingAt(10) }))).toEqual(
      failure(
        409,
        'PAYMENT_IN_PROGRESS',
        'A payment is already in progress. Check its status before trying again.',
      ),
    );
    expect(
      initiate(
        awaitingPayment({
          payment: {
            paid: false,
            pendingPaymentAt: new Date(NOW.getTime() - HOUR),
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('payment.recordOffline (05 §6.2)', () => {
  const record = (snap = awaitingPayment(), actor = finance, input?: unknown) =>
    check(PAYMENT_GUARDS, 'payment.recordOffline', snap, actor, input);

  it('passes for Finance on an accepted quote awaiting payment', () => {
    expect(record()).toEqual({ ok: true });
  });

  it('needs payment.record', () => {
    expect(record(awaitingPayment(), staff('refund.manage'))).toMatchObject({
      status: 403,
      message: 'Your staff role does not allow this action.',
    });
  });

  it('refuses when the quote is no longer awaiting payment', () => {
    expect(record(awaitingPayment({ status: 'matched' }))).toEqual(
      NOT_AWAITING,
    );
  });

  it('needs proof when the body is given', () => {
    expect(record(awaitingPayment(), finance, { amount: 1000 })).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Attach proof of the payment before recording it.',
      ),
    );
    expect(
      record(awaitingPayment(), finance, { proofFileId: 'upload-1' }),
    ).toEqual({ ok: true });
  });
});

describe('payment.reconcile (05 §6.2)', () => {
  const reconcile = (
    snap = awaitingPayment({ payment: recordedAt(60) }),
    actor = finance,
    input?: unknown,
  ) => check(PAYMENT_GUARDS, 'payment.reconcile', snap, actor, input);

  it('passes for Finance when a recorded payment is waiting', () => {
    expect(reconcile()).toEqual({ ok: true });
  });

  it('needs payment.record', () => {
    expect(reconcile(undefined, staff('payout.approve'))).toMatchObject({
      status: 403,
    });
  });

  it('refuses when no payment is waiting', () => {
    expect(reconcile(awaitingPayment())).toEqual(NOT_RECONCILABLE);
  });

  it.each(['matched', 'cancelled', 'closed', 'cancelling'] as const)(
    'still passes when the request is %s (late money is settled and refunded)',
    (status) => {
      expect(
        reconcile(awaitingPayment({ status, payment: recordedAt(60) })),
      ).toEqual({ ok: true });
    },
  );

  it('needs the offline flag, not just any pending payment', () => {
    expect(
      reconcile(
        awaitingPayment({
          payment: {
            paid: false,
            pendingPaymentAt: new Date(NOW.getTime() - 60 * 60_000),
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(NOT_RECONCILABLE);
  });

  it('needs a note when the body is given', () => {
    expect(reconcile(undefined, finance, { note: ' ' })).toEqual(
      failure(422, 'VALIDATION_ERROR', 'Add a reconciliation note.'),
    );
    expect(
      reconcile(undefined, finance, { note: 'Seen on the statement.' }),
    ).toEqual({ ok: true });
  });
});

describe('payment.rejectOffline (05 §6.2)', () => {
  const reject = (
    snap = awaitingPayment({ payment: recordedAt(60) }),
    actor = finance,
    input?: unknown,
  ) => check(PAYMENT_GUARDS, 'payment.rejectOffline', snap, actor, input);

  it('passes for Finance when a recorded payment is waiting', () => {
    expect(reject()).toEqual({ ok: true });
  });

  it('also passes after the quote lapsed', () => {
    expect(
      reject(awaitingPayment({ status: 'matched', payment: recordedAt(60) })),
    ).toEqual({ ok: true });
  });

  it('needs payment.record and a waiting payment', () => {
    expect(reject(undefined, staff())).toMatchObject({ status: 403 });
    expect(reject(awaitingPayment())).toEqual(NOT_RECONCILABLE);
  });

  it('needs the offline flag, not just any pending payment', () => {
    expect(
      reject(
        awaitingPayment({
          payment: {
            paid: false,
            pendingPaymentAt: new Date(NOW.getTime() - 60 * 60_000),
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(NOT_RECONCILABLE);
  });

  it('needs a reason when the body is given', () => {
    expect(reject(undefined, finance, { reason: '' })).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Add a reason for rejecting this payment.',
      ),
    );
    expect(
      reject(undefined, finance, { reason: 'Not on the statement.' }),
    ).toEqual({ ok: true });
  });
});
