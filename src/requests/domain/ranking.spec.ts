import { createHash } from 'node:crypto';
import { rankProviders, type DispatchWeights } from './ranking';
import type { DispatchProvider, DispatchRequest } from './eligibility';

const request: DispatchRequest = {
  id: 'request-uuid',
  ownerId: 'customer',
  service: 'Design',
  serviceId: 'svc:Design',
  skillId: null,
  locationId: 'd1',
  locationName: 'Wuse',
  locationIds: ['d1', 'state', 'city'],
  locationParentId: 'city',
};
const now = new Date('2026-10-23T12:00:00Z');
const weights: DispatchWeights = {
  area: 25,
  capacity: 20,
  fairness: 15,
  experience: 5,
  reliability: 0,
};
const only = (key: keyof DispatchWeights): DispatchWeights => ({
  area: 0,
  capacity: 0,
  fairness: 0,
  experience: 0,
  reliability: 0,
  [key]: 1,
});
const provider = (
  id: string,
  patch: Partial<DispatchProvider> = {},
): DispatchProvider => ({
  id,
  userId: `user-${id}`,
  name: id,
  verification: 'approved',
  userStatus: 'active',
  reliabilityStatus: 'normal',
  serviceIds: ['svc:Design'],
  skillIds: {},
  serviceAreaIds: ['d1'],
  available: true,
  capacity: 2,
  committedJobs: 0,
  workingHours: {},
  timeOff: [],
  hasVerifiedCurrentBank: true,
  lastOfferedAt: null,
  experience: 2,
  reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 },
  earlierEndReasons: [],
  ...patch,
});
const factorsOf = (
  patch: Partial<DispatchProvider>,
  req: DispatchRequest = request,
) => rankProviders([provider('p', patch)], req, weights, now)[0].factors;
const ids = (ranked: ReturnType<typeof rankProviders>) =>
  ranked.map(({ provider: item }) => item.id);
const hash = (providerId: string) =>
  createHash('sha256').update(`${request.id}${providerId}`).digest('hex');

describe('rankProviders (04 §6.6)', () => {
  describe('area factor', () => {
    it('is 1 when the provider lists the request place', () => {
      expect(factorsOf({ serviceAreaIds: ['d1'] }).area).toBe(1);
    });

    it('is 0.6 when only the direct parent is in serviceAreaIds', () => {
      expect(factorsOf({ serviceAreaIds: ['city'] }).area).toBe(0.6);
    });

    it('is 0.4 when only a higher ancestor is in serviceAreaIds', () => {
      expect(factorsOf({ serviceAreaIds: ['state'] }).area).toBe(0.4);
    });

    it('prefers the closest match when several are listed', () => {
      expect(factorsOf({ serviceAreaIds: ['city', 'd1'] }).area).toBe(1);
      expect(factorsOf({ serviceAreaIds: ['state', 'city'] }).area).toBe(0.6);
    });

    it('is 0.4 for a state when the request is an LGA with no area', () => {
      const lgaRequest: DispatchRequest = {
        ...request,
        locationId: 'city',
        locationIds: ['city', 'state'],
        locationParentId: 'state',
      };
      const [ranked] = rankProviders(
        [provider('p', { serviceAreaIds: ['state'] })],
        lgaRequest,
        weights,
        now,
      );
      expect(ranked.factors.area).toBe(0.6);
    });

    it('is 0 for neither', () => {
      expect(factorsOf({ serviceAreaIds: ['d2'] }).area).toBe(0);
    });
  });

  describe('capacity factor', () => {
    it('is 1 - committed / capacity, clamped to 0..1', () => {
      expect(factorsOf({ capacity: 4, committedJobs: 1 }).capacity).toBe(0.75);
      expect(factorsOf({ capacity: 2, committedJobs: 5 }).capacity).toBe(0);
      expect(factorsOf({ capacity: 0 }).capacity).toBe(0);
    });
  });

  describe('fairness factor', () => {
    it('is 1 for a provider never offered', () => {
      expect(factorsOf({ lastOfferedAt: null }).fairness).toBe(1);
    });

    it('is days since lastOfferedAt over 7, capped at 1', () => {
      const days = (count: number) =>
        new Date(now.getTime() - count * 86_400_000);
      expect(factorsOf({ lastOfferedAt: days(3.5) }).fairness).toBe(0.5);
      expect(factorsOf({ lastOfferedAt: days(0) }).fairness).toBe(0);
      expect(factorsOf({ lastOfferedAt: days(30) }).fairness).toBe(1);
    });
  });

  describe('experience factor', () => {
    it('is years / 20, clamped to 0..20', () => {
      expect(factorsOf({ experience: 10 }).experience).toBe(0.5);
      expect(factorsOf({ experience: 40 }).experience).toBe(1);
      expect(factorsOf({ experience: -3 }).experience).toBe(0);
    });
  });

  describe('reliability factor', () => {
    it('is 1 below five offers', () => {
      expect(
        factorsOf({
          reliability: { offers: 4, declines: 4, expiries: 0, noShows: 0 },
        }).reliability,
      ).toBe(1);
    });

    it('is 1 - (declines + expiries + no-shows) / offers from five offers', () => {
      expect(
        factorsOf({
          reliability: { offers: 10, declines: 1, expiries: 1, noShows: 0 },
        }).reliability,
      ).toBe(0.8);
      expect(
        factorsOf({
          reliability: { offers: 5, declines: 5, expiries: 5, noShows: 5 },
        }).reliability,
      ).toBe(0);
    });
  });

  describe('total', () => {
    it('is 100 x weighted sum over the weight sum, rounded to two places', () => {
      const [ranked] = rankProviders(
        [provider('p', { serviceAreaIds: ['city'], experience: 7 })],
        request,
        weights,
        now,
      );
      // (25*0.6 + 20*1 + 15*1 + 5*0.35) / 65
      expect(ranked.total).toBe(
        Math.round(((100 * (15 + 20 + 15 + 1.75)) / 65) * 100) / 100,
      );
    });

    it('does not depend on the scale of the weights', () => {
      const doubled = Object.fromEntries(
        Object.entries(weights).map(([key, value]) => [key, value * 2]),
      ) as DispatchWeights;
      const rows = [provider('a', { experience: 9 })];
      expect(rankProviders(rows, request, doubled, now)[0].total).toBe(
        rankProviders(rows, request, weights, now)[0].total,
      );
    });

    it('is 100 for a provider at every maximum', () => {
      expect(
        rankProviders(
          [provider('p', { experience: 20 })],
          request,
          { ...weights, reliability: 10 },
          now,
        )[0].total,
      ).toBe(100);
    });

    it('rejects weights that do not sum above zero', () => {
      const none: DispatchWeights = {
        area: 0,
        capacity: 0,
        fairness: 0,
        experience: 0,
        reliability: 0,
      };
      expect(() => rankProviders([provider('p')], request, none, now)).toThrow(
        RangeError,
      );
    });
  });

  describe('order', () => {
    it('sorts by total descending', () => {
      const ranked = rankProviders(
        [
          provider('low', { serviceAreaIds: ['d2'] }),
          provider('high', { serviceAreaIds: ['d1'] }),
          provider('mid', { serviceAreaIds: ['city'] }),
        ],
        request,
        only('area'),
        now,
      );
      expect(ids(ranked)).toEqual(['high', 'mid', 'low']);
    });

    it('breaks a tie by lastOfferedAt ascending, never offered first', () => {
      const day = (count: number) =>
        new Date(now.getTime() - count * 86_400_000);
      const ranked = rankProviders(
        [
          provider('recent', { lastOfferedAt: day(1) }),
          provider('old', { lastOfferedAt: day(10) }),
          provider('never', { lastOfferedAt: null }),
        ],
        request,
        only('area'),
        now,
      );
      expect(ids(ranked)).toEqual(['never', 'old', 'recent']);
    });

    it('breaks a remaining tie by sha256(request id + provider id) ascending', () => {
      const names = ['a', 'b', 'c', 'd'];
      const ranked = rankProviders(
        names.map((name) => provider(name)),
        request,
        only('area'),
        now,
      );
      expect(ids(ranked)).toEqual(
        [...names].sort((x, y) => hash(x).localeCompare(hash(y))),
      );
    });

    it('is stable for repeated inputs and independent of input order', () => {
      const rows = [
        provider('city-only', { serviceAreaIds: ['city'] }),
        provider('district'),
        provider('other', { serviceAreaIds: ['d2'] }),
      ];
      const first = rankProviders(rows, request, weights, now);
      const second = rankProviders([...rows].reverse(), request, weights, now);
      expect(ids(first)).toEqual(ids(second));
    });
  });
});
