import { evaluateEligibility, type DispatchProvider, type DispatchRequest } from './eligibility';

const request: DispatchRequest = {
  id: 'request-1', ownerId: 'customer-1', service: 'Design', skill: 'Architectural plan',
  districtId: 'district-1', districtName: 'Wuse II', cityId: 'city-1', effectiveStartDate: null,
};
const provider: DispatchProvider = {
  id: 'provider-1', userId: 'provider-user-1', name: 'A Provider', verification: 'approved',
  userStatus: 'active', delisted: false, services: ['Design'], skills: { Design: ['Architectural plan'] },
  serviceAreaIds: ['district-1'], cityId: 'city-1', available: true, capacity: 3, committedJobs: 0,
  workingHours: { mon: { start: '08:00', end: '17:00' } }, timeOff: [], hasVerifiedCurrentBank: true,
  lastOfferedAt: null, experience: 5, reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 }, earlierEndReasons: [],
};

describe('evaluateEligibility', () => {
  it.each([
    [{ verification: 'pending' }, 'verification', 'Not verified'],
    [{ userStatus: 'suspended' }, 'standing', 'Suspended'],
    [{ delisted: true }, 'standing', 'Delisted'],
    [{ userId: request.ownerId }, 'conflict', 'Own request'],
    [{ services: [] }, 'service', 'Doesn’t offer Design'],
    [{ available: false }, 'available', 'Not accepting new jobs'],
    [{ serviceAreaIds: [], cityId: null }, 'area', 'Doesn’t cover Wuse II'],
    [{ skills: { Design: [] } }, 'skill', 'Doesn’t offer Architectural plan'],
    [{ committedJobs: 3 }, 'capacity', 'At capacity (3 of 3 jobs)'],
    [{ earlierEndReasons: ['declined'] }, 'previous', 'Declined earlier'],
    [{ hasVerifiedCurrentBank: false }, 'bank', 'Bank details not verified'],
  ] as const)('reports the first failing rule', (change, rule, reason) => {
    const result = evaluateEligibility({ ...provider, ...change }, request, { requireVerifiedBank: true });
    expect(result).toEqual({ eligible: false, rule, reason });
  });

  it('accepts city coverage and checks the hire time-off span', () => {
    expect(evaluateEligibility({ ...provider, serviceAreaIds: [], cityId: 'city-1' }, request, { requireVerifiedBank: true })).toEqual({ eligible: true });
    const hire = { ...request, service: 'Hire', effectiveStartDate: '2026-10-26', effectiveEndDate: '2026-10-29' };
    const result = evaluateEligibility({ ...provider, timeOff: [{ from: '2026-10-28', to: '2026-10-29' }] }, hire, { requireVerifiedBank: true });
    expect(result).toEqual({ eligible: false, rule: 'day', reason: 'On time off during the hire (2026-10-28 to 2026-10-29)' });
  });
});
