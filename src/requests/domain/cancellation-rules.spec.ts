import { allowedActions } from './allowed-actions';
import {
  autoConfirmRestart,
  CANCELLATION_REASON_CODES,
  customerRefundStatus,
  workStartedOn,
} from './cancellation-rules';
import {
  assignment,
  customer,
  HOUR,
  NOW,
  snapshot,
  staff,
} from './guard.testkit';
import { REQUEST_GUARDS } from './request-guard-registry';
import type { ActorView, RequestSnapshot } from './snapshot';

describe('CANCELLATION_REASON_CODES', () => {
  it('lists the 04 §4.7 reason codes', () => {
    expect([...CANCELLATION_REASON_CODES]).toEqual([
      'customer_changed_mind',
      'quote_declined',
      'no_response',
      'payment_lapsed',
      'no_provider',
      'provider_no_show',
      'provider_suspended',
      'customer_suspended',
      'scope_dispute',
      'duplicate',
      'other',
    ]);
  });
});

describe('workStartedOn (04 §4.7)', () => {
  it('is true when any assignment, current or replaced, has workStarted', () => {
    expect(workStartedOn(snapshot())).toBe(false);
    expect(
      workStartedOn(
        snapshot({
          assignments: [
            assignment('replaced', { workStarted: true }),
            assignment('accepted'),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      workStartedOn(snapshot({ assignments: [assignment('accepted')] })),
    ).toBe(false);
  });
});

describe('customerRefundStatus (FX-3.11 refundStatus projection)', () => {
  it.each([
    [[], null],
    [['pending_approval'], 'pending'],
    [['awaiting_second_approval'], 'pending'],
    [['approved'], 'processing'],
    [['processing'], 'processing'],
    [['failed'], 'processing'],
    [['completed'], 'completed'],
    [['waived'], 'waived'],
    [['completed', 'waived'], 'completed'],
    [['completed', 'pending_approval'], 'pending'],
    [['completed', 'processing'], 'processing'],
    [['rejected'], 'pending'],
    [['rejected', 'completed'], 'completed'],
  ] as Array<[string[], string | null]>)(
    'maps %j to %s',
    (statuses, expected) =>
      expect(customerRefundStatus(statuses)).toBe(expected),
  );
});

describe('autoConfirmRestart (T17 after a rejected or withdrawn cancellation)', () => {
  const approvedAt = new Date(NOW.getTime() - 30 * HOUR);

  it('resumes from the original due time and keeps only reminders still ahead', () => {
    const confirmDueAt = new Date(approvedAt.getTime() + 72 * HOUR);
    expect(
      autoConfirmRestart({ confirmDueAt, reportApprovedAt: approvedAt }, NOW),
    ).toEqual({
      autoConfirmAt: confirmDueAt,
      reminders: [
        {
          kind: 'T17.reminder48h',
          dueAt: new Date(approvedAt.getTime() + 48 * HOUR),
        },
      ],
    });
  });

  it('gives the customer one more hour when the due time has passed, with no reminders', () => {
    const confirmDueAt = new Date(NOW.getTime() - 2 * HOUR);
    expect(
      autoConfirmRestart({ confirmDueAt, reportApprovedAt: approvedAt }, NOW),
    ).toEqual({
      autoConfirmAt: new Date(NOW.getTime() + HOUR),
      reminders: [],
    });
  });

  it('does nothing without a due time', () => {
    expect(
      autoConfirmRestart(
        { confirmDueAt: null, reportApprovedAt: approvedAt },
        NOW,
      ),
    ).toBeNull();
  });
});

describe('allowedActions for cancellation (plan FX-3.11 contract)', () => {
  const actions = (snap: RequestSnapshot, actor: ActorView) =>
    allowedActions(snap, actor, NOW, {}, REQUEST_GUARDS).filter(
      (action) =>
        action.startsWith('request.cancel') ||
        action.startsWith('cancellation.'),
    );
  const ops = staff('request.cancel');
  const pending = {
    pendingCancellation: true,
    pendingCancellationInfo: {
      id: 'c-1',
      status: 'pending' as const,
      requestedBy: 'customer' as const,
      paid: false,
      workStarted: false,
    },
  };

  it('shows the customer request.cancel while free cancel is allowed', () => {
    expect(actions(snapshot({ status: 'submitted' }), customer())).toEqual([
      'request.cancel',
    ]);
  });

  it('shows the customer cancellation.request once it is not', () => {
    expect(actions(snapshot({ status: 'under_review' }), customer())).toEqual([
      'cancellation.request',
    ]);
  });

  it('offers withdraw instead of a second request while one is pending', () => {
    expect(
      actions(snapshot({ status: 'matched', ...pending }), customer()),
    ).toEqual(['cancellation.withdraw']);
  });

  it('shows staff request.cancel, or the decision when a request is waiting', () => {
    expect(actions(snapshot({ status: 'matched' }), ops)).toEqual([
      'request.cancel',
    ]);
    expect(actions(snapshot({ status: 'matched', ...pending }), ops)).toEqual([
      'cancellation.decide',
    ]);
  });

  it('hides the staff cancel for a paid job from staff without request.cancel.active', () => {
    const paid = snapshot({
      status: 'scheduled',
      payment: { paid: true, pendingPaymentAt: null, offlineRecorded: false },
    });
    expect(actions(paid, ops)).toEqual([]);
    expect(
      actions(paid, staff('request.cancel', 'request.cancel.active')),
    ).toEqual(['request.cancel']);
  });
});
