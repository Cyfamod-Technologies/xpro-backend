import type { RequestSnapshot } from './snapshot';
import { deriveStage, nextActor, type RequestStage } from './stage';

const now = new Date('2026-10-23T12:00:00.000Z');

function snapshot(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    id: 'uuid',
    number: 'XPR-00001',
    status: 'submitted',
    intake: { state: 'pending' },
    currentAssignment: null,
    assignments: [],
    latestQuote: null,
    quotes: [],
    currentSchedule: null,
    replacedSchedule: null,
    pendingUpdates: [],
    openIssues: [],
    pendingCancellation: false,
    latestNoShow: null,
    payment: { paid: false, pendingPaymentAt: null },
    payout: null,
    customerStanding: 'active',
    providerStanding: null,
    cascadePending: false,
    ...overrides,
  };
}

const rows: Array<{
  row: string;
  expected: RequestStage;
  make: () => RequestSnapshot;
}> = [
  {
    row: 'submitted / intake pending',
    expected: 'intake_review',
    make: () => snapshot(),
  },
  {
    row: 'submitted / clarification',
    expected: 'awaiting_clarification',
    make: () => snapshot({ intake: { state: 'clarification' } }),
  },
  {
    row: 'under_review / no current assignment',
    expected: 'dispatching',
    make: () =>
      snapshot({ status: 'under_review', intake: { state: 'approved' } }),
  },
  {
    row: 'under_review / offer out',
    expected: 'offer_out',
    make: () =>
      snapshot({
        status: 'under_review',
        currentAssignment: { status: 'offered', attempt: 1, expiresAt: now },
      }),
  },
  {
    row: 'under_review / acceptance review',
    expected: 'acceptance_review',
    make: () =>
      snapshot({
        status: 'under_review',
        currentAssignment: {
          status: 'pending_approval',
          attempt: 1,
          expiresAt: now,
        },
      }),
  },
  {
    row: 'under_review / replacement',
    expected: 'replacing_provider',
    make: () =>
      snapshot({
        status: 'under_review',
        latestQuote: {
          status: 'accepted',
          version: 1,
          approvalRequestedAt: null,
          validUntil: null,
          payoutAmount: null,
        },
      }),
  },
  {
    row: 'matched / pricing',
    expected: 'pricing',
    make: () => snapshot({ status: 'matched' }),
  },
  {
    row: 'matched / quote awaiting sign-off',
    expected: 'quote_approval',
    make: () =>
      snapshot({
        status: 'matched',
        latestQuote: {
          status: 'draft',
          version: 1,
          approvalRequestedAt: now,
          validUntil: null,
          payoutAmount: null,
        },
      }),
  },
  {
    row: 'matched / quote revision',
    expected: 'quote_revision',
    make: () =>
      snapshot({
        status: 'matched',
        latestQuote: {
          status: 'revision_requested',
          version: 2,
          approvalRequestedAt: null,
          validUntil: null,
          payoutAmount: null,
        },
      }),
  },
  {
    row: 'matched / quote expired',
    expected: 'quote_expired',
    make: () =>
      snapshot({
        status: 'matched',
        latestQuote: {
          status: 'expired',
          version: 1,
          approvalRequestedAt: null,
          validUntil: now,
          payoutAmount: null,
        },
      }),
  },
  {
    row: 'matched / payment lapsed',
    expected: 'payment_lapsed',
    make: () => snapshot({ status: 'matched', paymentLapsed: true }),
  },
  {
    row: 'quoted / latest quote sent',
    expected: 'quote_with_customer',
    make: () =>
      snapshot({
        status: 'quoted',
        latestQuote: {
          status: 'sent',
          version: 3,
          approvalRequestedAt: null,
          validUntil: now,
          payoutAmount: null,
        },
      }),
  },
  {
    row: 'awaiting_payment',
    expected: 'awaiting_payment',
    make: () => snapshot({ status: 'awaiting_payment' }),
  },
  {
    row: 'ready_to_schedule / replacement payout missing',
    expected: 'set_payout',
    make: () =>
      snapshot({ status: 'ready_to_schedule', replacementPayoutPending: true }),
  },
  {
    row: 'ready_to_schedule / no live proposal',
    expected: 'scheduling',
    make: () => snapshot({ status: 'ready_to_schedule' }),
  },
  {
    row: 'ready_to_schedule / proposed schedule',
    expected: 'schedule_proposed',
    make: () =>
      snapshot({
        status: 'ready_to_schedule',
        currentSchedule: {
          status: 'proposed',
          startAt: now,
          endAt: new Date(now.getTime() + 3_600_000),
          customer: 'pending',
          provider: 'pending',
          changeRequests: [],
        },
      }),
  },
  {
    row: 'ready_to_schedule / changes requested',
    expected: 'schedule_changes',
    make: () =>
      snapshot({
        status: 'ready_to_schedule',
        currentSchedule: {
          status: 'changes_requested',
          startAt: now,
          endAt: new Date(now.getTime() + 3_600_000),
          customer: 'changes_requested',
          provider: 'pending',
          changeRequests: [],
        },
      }),
  },
  {
    row: 'scheduled / confirmed schedule',
    expected: 'scheduled',
    make: () =>
      snapshot({
        status: 'scheduled',
        currentSchedule: {
          status: 'confirmed',
          startAt: now,
          endAt: new Date(now.getTime() + 3_600_000),
          customer: 'accepted',
          provider: 'accepted',
          changeRequests: [],
        },
      }),
  },
  {
    row: 'scheduled / reschedule request',
    expected: 'reschedule',
    make: () =>
      snapshot({
        status: 'scheduled',
        currentSchedule: {
          status: 'confirmed',
          startAt: now,
          endAt: new Date(now.getTime() + 3_600_000),
          customer: 'accepted',
          provider: 'accepted',
          changeRequests: [{ handledAt: null }],
        },
      }),
  },
  {
    row: 'in_progress / work',
    expected: 'in_progress',
    make: () => snapshot({ status: 'in_progress' }),
  },
  {
    row: 'in_progress / rework',
    expected: 'rework',
    make: () =>
      snapshot({ status: 'in_progress', openIssues: [{ status: 'rework' }] }),
  },
  {
    row: 'blocked / approved provider blocker',
    expected: 'blocked_provider',
    make: () => snapshot({ status: 'blocked' }),
  },
  {
    row: 'blocked / staff hold',
    expected: 'on_hold',
    make: () => snapshot({ status: 'blocked', hold: { kind: 'staff' } }),
  },
  {
    row: 'blocked / open issue',
    expected: 'issue_open',
    make: () =>
      snapshot({ status: 'blocked', openIssues: [{ status: 'open' }] }),
  },
  {
    row: 'blocked / dispute',
    expected: 'dispute',
    make: () =>
      snapshot({ status: 'blocked', openIssues: [{ status: 'disputed' }] }),
  },
  {
    row: 'completion_pending',
    expected: 'awaiting_customer_confirmation',
    make: () => snapshot({ status: 'completion_pending' }),
  },
  {
    row: 'acknowledged / within defects window',
    expected: 'defects_window',
    make: () =>
      snapshot({
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(now.getTime() + 1),
      }),
  },
  {
    row: 'acknowledged / window ended',
    expected: 'ready_to_close',
    make: () => snapshot({ status: 'acknowledged', defectsWindowEndsAt: now }),
  },
  {
    row: 'closed',
    expected: 'closed',
    make: () => snapshot({ status: 'closed' }),
  },
  {
    row: 'cancelling',
    expected: 'refund_pending',
    make: () => snapshot({ status: 'cancelling' }),
  },
  {
    row: 'cancelled',
    expected: 'cancelled',
    make: () => snapshot({ status: 'cancelled' }),
  },
  {
    row: 'rejected',
    expected: 'rejected',
    make: () => snapshot({ status: 'rejected' }),
  },
];

describe('deriveStage (§5.3)', () => {
  it.each(rows)('$row', ({ expected, make }) => {
    expect(deriveStage(make(), now)).toBe(expected);
  });

  it('uses the next pending party for a proposed schedule', () => {
    const snap = snapshot({
      status: 'ready_to_schedule',
      currentSchedule: {
        status: 'proposed',
        startAt: now,
        endAt: new Date(now.getTime() + 3_600_000),
        customer: 'accepted',
        provider: 'pending',
        changeRequests: [],
      },
    });
    expect(nextActor(snap, deriveStage(snap, now), now)).toBe('provider');
  });

  it('uses the next pending party during a reschedule proposal', () => {
    const snap = snapshot({
      status: 'scheduled',
      currentSchedule: {
        status: 'proposed',
        startAt: now,
        endAt: new Date(now.getTime() + 3_600_000),
        customer: 'accepted',
        provider: 'pending',
        changeRequests: [],
      },
    });
    expect(deriveStage(snap, now)).toBe('reschedule');
    expect(nextActor(snap, 'reschedule', now)).toBe('provider');
  });

  it('returns every table next actor for representative states', () => {
    expect(nextActor(snapshot(), 'intake_review', now)).toBe(
      'staff:request.review',
    );
    expect(
      nextActor(snapshot({ cascadePending: true }), 'dispatching', now),
    ).toBe('system');
    expect(
      nextActor(snapshot({ providerCostingSubmitted: true }), 'pricing', now),
    ).toBe('staff:quote.manage');
    expect(nextActor(snapshot(), 'defects_window', now)).toBe('none');
  });
});
