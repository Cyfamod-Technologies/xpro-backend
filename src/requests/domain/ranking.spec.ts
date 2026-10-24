import { rankProviders, type DispatchWeights } from './ranking';
import type { DispatchProvider, DispatchRequest } from './eligibility';

const request: DispatchRequest = { id: 'request-uuid', ownerId: 'customer', service: 'Design', districtId: 'd1', districtName: 'Wuse', cityId: 'city' };
const weights: DispatchWeights = { area: 25, capacity: 20, fairness: 15, experience: 5, reliability: 0 };
const provider = (id: string, patch: Partial<DispatchProvider> = {}): DispatchProvider => ({
  id, userId: `user-${id}`, name: id, verification: 'approved', userStatus: 'active', delisted: false,
  services: ['Design'], skills: {}, serviceAreaIds: ['d1'], cityId: 'city', available: true,
  capacity: 2, committedJobs: 0, workingHours: {}, timeOff: [], hasVerifiedCurrentBank: true,
  lastOfferedAt: null, experience: 2, reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 }, earlierEndReasons: [], ...patch,
});

describe('rankProviders', () => {
  it('uses district and city area factors and stable order for repeated inputs', () => {
    const rows = [provider('city-only', { serviceAreaIds: [], cityId: 'city' }), provider('district')];
    const first = rankProviders(rows, request, weights, new Date('2026-10-23T12:00:00Z'));
    const second = rankProviders(rows, request, weights, new Date('2026-10-23T12:00:00Z'));
    expect(first.map(({ provider: item }) => item.id)).toEqual(second.map(({ provider: item }) => item.id));
    expect(first[0]?.factors.area).toBe(1);
    expect(first[1]?.factors.area).toBe(0.6);
  });
});
