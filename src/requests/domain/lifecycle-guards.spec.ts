import { LIFECYCLE_GUARDS } from './lifecycle-guards';
import type { RequestSnapshot } from './snapshot';

describe('lifecycle allowed-action guards', () => {
  const snapshot = (overrides: Partial<RequestSnapshot> = {}) => ({
    id: 'r1', number: 'XPR-00001', ownerId: 'c1', currentProviderUserId: 'p1', status: 'scheduled',
    intake: { state: 'approved' }, currentAssignment: null, assignments: [], latestQuote: null, quotes: [], currentSchedule: null, replacedSchedule: null,
    pendingUpdates: [], openIssues: [], pendingCancellation: false, latestNoShow: null, payment: { paid: false, pendingPaymentAt: null }, payout: null,
    customerStanding: 'active', providerStanding: 'active', cascadePending: false, ...overrides,
  }) as RequestSnapshot;
  it('limits schedule responses to the current customer or provider', () => {
    const row = snapshot({ currentSchedule: { status: 'proposed', startAt: new Date(), endAt: new Date(), customer: 'pending', provider: 'pending', changeRequests: [] } });
    expect(LIFECYCLE_GUARDS['schedule.respond'](row, { kind: 'customer', userId: 'c1' }, undefined, new Date(), {}).ok).toBe(true);
    expect(LIFECYCLE_GUARDS['schedule.respond'](row, { kind: 'provider', userId: 'other' }, undefined, new Date(), {}).ok).toBe(false);
  });
  it('blocks close when issues remain', () => {
    const row = snapshot({ status: 'acknowledged', openIssues: [{ status: 'open' }] });
    expect(LIFECYCLE_GUARDS['request.close'](row, { kind: 'staff', permissions: new Set(['request.close']) }, undefined, new Date(), {}).ok).toBe(false);
  });
});
