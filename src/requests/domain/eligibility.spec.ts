import {
  evaluateAll,
  evaluateEligibility,
  OVERRIDABLE_RULES,
  type DispatchProvider,
  type DispatchRequest,
} from './eligibility';

const request: DispatchRequest = {
  id: 'request-1',
  ownerId: 'customer-1',
  service: 'Design',
  serviceId: 'svc:Design',
  skill: 'Architectural plan',
  skillId: 'skill:architectural-plan',
  locationId: 'district-1',
  locationName: 'Wuse II',
  locationIds: ['district-1', 'state-1', 'city-1'],
  locationParentId: 'city-1',
  effectiveStartDate: null,
};
const provider: DispatchProvider = {
  id: 'provider-1',
  userId: 'provider-user-1',
  name: 'A Provider',
  verification: 'approved',
  userStatus: 'active',
  reliabilityStatus: 'normal',
  serviceIds: ['svc:Design'],
  skillIds: { 'svc:Design': ['skill:architectural-plan'] },
  serviceAreaIds: ['district-1'],
  available: true,
  capacity: 3,
  committedJobs: 0,
  workingHours: {
    mon: { start: '08:00', end: '17:00' },
    tue: { start: '08:00', end: '17:00' },
  },
  timeOff: [],
  hasVerifiedCurrentBank: true,
  lastOfferedAt: null,
  experience: 5,
  reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 },
  earlierEndReasons: [],
};
const options = { requireVerifiedBank: true };
const evaluate = (
  change: Partial<DispatchProvider> = {},
  over: Partial<DispatchRequest> = {},
) =>
  evaluateEligibility(
    { ...provider, ...change },
    { ...request, ...over },
    options,
  );

describe('evaluateEligibility (04 §6.5)', () => {
  it('accepts a provider that passes every rule', () => {
    expect(evaluate()).toEqual({ eligible: true });
  });

  describe.each([
    ['E1', { verification: 'pending' }, 'verification', 'Not verified'],
    ['E1', { verification: 'rejected' }, 'verification', 'Not verified'],
    ['E2', { userStatus: 'suspended' }, 'standing', 'Suspended'],
    ['E2', { verification: 'delisted' }, 'standing', 'Delisted'],
    ['E2', { reliabilityStatus: 'restricted' }, 'standing', 'Restricted'],
    ['E3', { userId: 'customer-1' }, 'conflict', 'Own request'],
    ['E4', { serviceIds: [] }, 'service', 'Doesn’t offer Design'],
    ['E5', { available: false }, 'available', 'Not accepting new jobs'],
    ['E6', { serviceAreaIds: [] }, 'area', 'Doesn’t cover Wuse II'],
    [
      'E8',
      { skillIds: { 'svc:Design': [] } },
      'skill',
      'Doesn’t offer Architectural plan',
    ],
    ['E9', { committedJobs: 3 }, 'capacity', 'At capacity (3 of 3 jobs)'],
    [
      'E11',
      { hasVerifiedCurrentBank: false },
      'bank',
      'Bank details not verified',
    ],
  ] as const)('%s', (_row, change, rule, reason) => {
    it(`excludes with ${rule}: ${reason}`, () => {
      expect(evaluate(change)).toEqual({ eligible: false, rule, reason });
    });
  });

  describe('E2 standing', () => {
    it.each(['reliable', 'normal', 'review_due'])(
      'does not exclude reliability status %s',
      (reliabilityStatus) => {
        expect(evaluate({ reliabilityStatus })).toEqual({ eligible: true });
      },
    );
  });

  describe('E6 area (04 §4.3: a place id covers everything under it)', () => {
    it('is satisfied by the request place', () => {
      expect(evaluate({ serviceAreaIds: ['district-1'] })).toEqual({
        eligible: true,
      });
    });

    it('is satisfied by the request LGA in serviceAreaIds', () => {
      expect(evaluate({ serviceAreaIds: ['city-1'] })).toEqual({
        eligible: true,
      });
    });

    it('is satisfied through any ancestor: a provider covering the state covers an area in it', () => {
      expect(evaluate({ serviceAreaIds: ['state-1'] })).toEqual({
        eligible: true,
      });
    });

    it('is not satisfied by another area, LGA or state', () => {
      expect(
        evaluate({ serviceAreaIds: ['district-9', 'city-9', 'state-9'] }),
      ).toEqual({
        eligible: false,
        rule: 'area',
        reason: 'Doesn’t cover Wuse II',
      });
    });
  });

  describe('E7 day', () => {
    // 2026-10-26 is a Monday, 2026-10-27 a Tuesday and 2026-10-28 a Wednesday.
    it('is skipped when there is no effective start date', () => {
      expect(
        evaluate({
          workingHours: {},
          timeOff: [{ from: '2026-01-01', to: '2027-01-01' }],
        }),
      ).toEqual({ eligible: true });
    });

    it('passes on a working weekday', () => {
      expect(evaluate({}, { effectiveStartDate: '2026-10-26' })).toEqual({
        eligible: true,
      });
    });

    it('excludes a weekday without working hours', () => {
      expect(evaluate({}, { effectiveStartDate: '2026-10-28' })).toEqual({
        eligible: false,
        rule: 'day',
        reason: 'Doesn’t work on Wednesdays',
      });
    });

    it('excludes a start date in time off', () => {
      expect(
        evaluate(
          { timeOff: [{ from: '2026-10-26', to: '2026-10-27' }] },
          { effectiveStartDate: '2026-10-26' },
        ),
      ).toEqual({
        eligible: false,
        rule: 'day',
        reason: 'On time off on 2026-10-26',
      });
    });

    it('ignores time off on other dates for a non-Hire request', () => {
      expect(
        evaluate(
          { timeOff: [{ from: '2026-10-27', to: '2026-10-27' }] },
          {
            effectiveStartDate: '2026-10-26',
            effectiveEndDate: '2026-10-28',
          },
        ),
      ).toEqual({ eligible: true });
    });

    describe('Hire spans startDate to endDate', () => {
      const hire = {
        service: 'Hiring',
        serviceId: 'svc:Hiring',
        skill: null,
        skillId: null,
        effectiveStartDate: '2026-10-26',
        effectiveEndDate: '2026-10-29',
      };
      const hiring = { serviceIds: ['svc:Hiring'] };

      it('excludes time off inside the span', () => {
        expect(
          evaluate(
            { ...hiring, timeOff: [{ from: '2026-10-28', to: '2026-10-29' }] },
            hire,
          ),
        ).toEqual({
          eligible: false,
          rule: 'day',
          reason: 'On time off during the hire (2026-10-28 to 2026-10-29)',
        });
      });

      it('names the span message when the start date itself is in time off', () => {
        expect(
          evaluate(
            { ...hiring, timeOff: [{ from: '2026-10-25', to: '2026-10-26' }] },
            hire,
          ),
        ).toEqual({
          eligible: false,
          rule: 'day',
          reason: 'On time off during the hire (2026-10-25 to 2026-10-26)',
        });
      });

      it('passes when time off ends before the hire starts', () => {
        expect(
          evaluate(
            { ...hiring, timeOff: [{ from: '2026-10-20', to: '2026-10-25' }] },
            hire,
          ),
        ).toEqual({ eligible: true });
      });
    });
  });

  describe('E8 skill', () => {
    it('is skipped when the request has no skill', () => {
      expect(
        evaluate({ skillIds: {} }, { skill: null, skillId: null }),
      ).toEqual({ eligible: true });
    });

    it('looks the skill up under the request service only', () => {
      expect(
        evaluate({
          skillIds: { 'svc:Hiring': ['skill:architectural-plan'] },
        }),
      ).toMatchObject({ eligible: false, rule: 'skill' });
    });

    it('matches by id, so a renamed service or skill still passes', () => {
      expect(
        evaluate({}, { service: 'Design studio', skill: 'Plans (architects)' }),
      ).toEqual({ eligible: true });
    });

    it('does not match a stored name that equals the request skill name', () => {
      expect(
        evaluate(
          { skillIds: { 'svc:Design': ['Architectural plan'] } },
          { skillId: 'skill:architectural-plan' },
        ),
      ).toEqual({
        eligible: false,
        rule: 'skill',
        reason: 'Doesn’t offer Architectural plan',
      });
    });

    it('fails a request whose skill could not be resolved to an id', () => {
      expect(evaluate({}, { skillId: null })).toEqual({
        eligible: false,
        rule: 'skill',
        reason: 'Doesn’t offer Architectural plan',
      });
    });
  });

  describe('E4 service by id', () => {
    it('fails a request whose service could not be resolved to an id', () => {
      expect(evaluate({}, { serviceId: null })).toEqual({
        eligible: false,
        rule: 'service',
        reason: 'Doesn’t offer Design',
      });
    });
  });

  describe('E9 capacity', () => {
    it('allows one job below capacity', () => {
      expect(evaluate({ committedJobs: 2 })).toEqual({ eligible: true });
    });
  });

  describe('E10 previous', () => {
    it.each([
      ['declined', 'Declined earlier'],
      ['expired', 'Offer expired earlier'],
      ['not_confirmed', 'Not confirmed earlier'],
      ['withdrawn', 'Withdrawn earlier'],
      ['replaced', 'Replaced earlier'],
    ])('excludes after an assignment that ended %s', (ended, reason) => {
      expect(evaluate({ earlierEndReasons: [ended] })).toEqual({
        eligible: false,
        rule: 'previous',
        reason,
      });
    });

    it('does not exclude an end reason that is not listed (edits are excepted)', () => {
      expect(evaluate({ earlierEndReasons: ['request_edited'] })).toEqual({
        eligible: true,
      });
    });
  });

  describe('E11 bank', () => {
    it('is skipped when verified bank details are not required', () => {
      expect(
        evaluateEligibility(
          { ...provider, hasVerifiedCurrentBank: false },
          request,
          { requireVerifiedBank: false },
        ),
      ).toEqual({ eligible: true });
    });
  });

  it('reports the first failing rule in E1 to E11 order', () => {
    expect(
      evaluate({
        available: false,
        serviceAreaIds: [],
        hasVerifiedCurrentBank: false,
      }),
    ).toMatchObject({ rule: 'available' });
    expect(
      evaluate({ serviceAreaIds: [], hasVerifiedCurrentBank: false }),
    ).toMatchObject({ rule: 'area' });
  });
});

describe('evaluateAll', () => {
  it('is empty for an eligible provider', () => {
    expect(evaluateAll(provider, request, options)).toEqual([]);
  });

  it('lists every failing rule in spec order, not only the first', () => {
    const failures = evaluateAll(
      {
        ...provider,
        serviceAreaIds: [],
        skillIds: {},
        committedJobs: 3,
        earlierEndReasons: ['declined'],
        hasVerifiedCurrentBank: false,
      },
      request,
      options,
    );
    expect(failures.map(({ rule }) => rule)).toEqual([
      'area',
      'skill',
      'capacity',
      'previous',
      'bank',
    ]);
    expect(failures.every(({ rule }) => OVERRIDABLE_RULES.includes(rule))).toBe(
      true,
    );
  });

  it('keeps the never-overridable rules out of OVERRIDABLE_RULES', () => {
    const never = [
      'verification',
      'standing',
      'conflict',
      'service',
      'available',
    ];
    expect(OVERRIDABLE_RULES.filter((rule) => never.includes(rule))).toEqual(
      [],
    );
  });
});
