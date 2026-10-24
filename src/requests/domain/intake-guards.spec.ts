import {
  canClarify,
  canFreeCancel,
  canReject,
  canReview,
} from './intake-guards';
import type { RequestSnapshot } from './snapshot';

const snapshot = (overrides: Partial<RequestSnapshot> = {}) =>
  ({
    status: 'submitted',
    ownerId: 'customer-1',
    intake: { state: 'pending' },
    assignments: [],
    pendingCancellation: false,
    customerStanding: 'active',
    ...overrides,
  }) as RequestSnapshot;

const staff = (permissions: string[]) => ({
  kind: 'staff' as const,
  permissions: new Set(permissions),
});
const customer = { kind: 'customer' as const, userId: 'customer-1' };
const now = new Date('2026-10-23T12:00:00.000Z');

describe('intake action guards', () => {
  it.each([
    ['clarify', canClarify, staff(['request.clarify']), snapshot(), true],
    [
      'clarify accepts review permission',
      canClarify,
      staff(['request.review']),
      snapshot(),
      true,
    ],
    [
      'clarify rejects post-intake state',
      canClarify,
      staff(['request.clarify']),
      snapshot({ status: 'under_review' }),
      false,
    ],
    [
      'review permits operations on active submitted request',
      canReview,
      staff(['request.review']),
      snapshot(),
      true,
    ],
    [
      'review blocks suspended customer',
      canReview,
      staff(['request.review']),
      snapshot({ customerStanding: 'suspended' }),
      false,
    ],
    [
      'review blocks pending cancellation',
      canReview,
      staff(['request.review']),
      snapshot({ pendingCancellation: true }),
      false,
    ],
    [
      'reject permits submitted request',
      canReject,
      staff(['request.review']),
      snapshot(),
      true,
    ],
    [
      'reject blocks non-submitted request',
      canReject,
      staff(['request.review']),
      snapshot({ status: 'under_review' }),
      false,
    ],
    [
      'free cancel permits owner before offer and approval',
      canFreeCancel,
      customer,
      snapshot(),
      true,
    ],
    [
      'free cancel blocks non-owner',
      canFreeCancel,
      { ...customer, userId: 'other' },
      snapshot(),
      false,
    ],
    [
      'free cancel blocks approved intake',
      canFreeCancel,
      customer,
      snapshot({ intake: { state: 'approved' } }),
      false,
    ],
    [
      'free cancel blocks sent offer',
      canFreeCancel,
      customer,
      snapshot({
        assignments: [{ status: 'offered', attempt: 1, expiresAt: now }],
      }),
      false,
    ],
  ])('%s', (_label, guard, actor, snap, succeeds) => {
    const result = guard(snap, actor, undefined, now, {});
    expect(result.ok).toBe(succeeds);
  });

  it('preserves the specified conflict and validation messages', () => {
    expect(
      canClarify(
        snapshot({ status: 'under_review' }),
        staff(['request.clarify']),
        undefined,
        now,
        {},
      ),
    ).toMatchObject({
      message: 'This request has moved beyond intake review.',
    });
    expect(
      canReview(
        snapshot({ customerStanding: 'suspended' }),
        staff(['request.review']),
        undefined,
        now,
        {},
      ),
    ).toMatchObject({
      message:
        'This customer is suspended. Resolve the suspension before approving.',
    });
    expect(
      canReject(
        snapshot({ status: 'under_review' }),
        staff(['request.review']),
        undefined,
        now,
        {},
      ),
    ).toMatchObject({
      message: 'Only a request still in intake review can be rejected.',
    });
  });
});
