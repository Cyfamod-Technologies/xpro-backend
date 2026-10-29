import { seededCatalog } from '../../platform/catalog/catalog.testkit';
import { buildDispatchRequest } from './dispatch-request';
import { evaluateEligibility, type DispatchProvider } from './eligibility';

const base = {
  id: 'request-1',
  ownerId: 'customer-1',
  districtId: 'district-1',
  cityId: 'city-1',
};
const locations = { districtName: 'Wuse II', cityName: 'Abuja' };

describe('buildDispatchRequest (04 §4.9, C.6)', () => {
  it.each([
    ['Design', { designType: 'Architectural plan' }, 'Architectural plan'],
    ['Construction', { workType: 'Roof and ceiling' }, 'Roof and ceiling'],
    ['Hire', { trade: 'Plumber' }, 'Plumber'],
    ['Procurement', { category: 'Cement and blocks' }, 'Cement and blocks'],
    ['Facility management', { serviceNeeds: 'Pest control' }, 'Pest control'],
    ['Waste management', { wasteType: 'Commercial' }, 'Commercial'],
  ])(
    'reads the %s skill from its catalogue skill field',
    (service, details, skill) => {
      const result = buildDispatchRequest(
        { ...base, service, startDate: null, details },
        locations,
      );
      expect(result.skill).toBe(skill);
    },
  );

  it('has no skill when the skill field is empty or the details carry another key', () => {
    expect(
      buildDispatchRequest(
        {
          ...base,
          service: 'Design',
          startDate: null,
          details: { skill: 'x' },
        },
        locations,
      ).skill,
    ).toBeNull();
    expect(
      buildDispatchRequest(
        {
          ...base,
          service: 'Design',
          startDate: null,
          details: { designType: '' },
        },
        locations,
      ).skill,
    ).toBeNull();
  });

  describe('effective dates', () => {
    const dates = (
      service: string,
      startDate: string | null,
      details: Record<string, unknown>,
    ) => {
      const result = buildDispatchRequest(
        { ...base, service, startDate, details },
        locations,
      );
      return [result.effectiveStartDate, result.effectiveEndDate];
    };

    it('uses startDate for Design and Construction', () => {
      expect(dates('Design', '2026-11-02', {})).toEqual(['2026-11-02', null]);
      expect(dates('Construction', null, {})).toEqual([null, null]);
    });

    it('uses startDate and endDate for Hire', () => {
      expect(dates('Hire', '2026-11-02', { endDate: '2026-11-06' })).toEqual([
        '2026-11-02',
        '2026-11-06',
      ]);
    });

    it('ignores an endDate on a service other than Hire', () => {
      expect(dates('Design', '2026-11-02', { endDate: '2026-11-06' })).toEqual([
        '2026-11-02',
        null,
      ]);
    });

    it('uses pickupDate for Waste management', () => {
      expect(
        dates('Waste management', '2026-11-02', { pickupDate: '2026-11-09' }),
      ).toEqual(['2026-11-09', null]);
    });

    it('uses deliveryDate for Procurement', () => {
      expect(
        dates('Procurement', '2026-11-02', { deliveryDate: '2026-11-10' }),
      ).toEqual(['2026-11-10', null]);
    });

    it('uses visitDate for Facility management when given, else startDate', () => {
      expect(
        dates('Facility management', '2026-11-02', { visitDate: '2026-11-12' }),
      ).toEqual(['2026-11-12', null]);
      expect(dates('Facility management', '2026-11-02', {})).toEqual([
        '2026-11-02',
        null,
      ]);
    });
  });

  it('carries the district and city names, not their ids', () => {
    const result = buildDispatchRequest(
      { ...base, service: 'Design', startDate: null, details: {} },
      locations,
    );
    expect(result).toMatchObject({
      id: 'request-1',
      ownerId: 'customer-1',
      service: 'Design',
      districtId: 'district-1',
      districtName: 'Wuse II',
      cityId: 'city-1',
      cityName: 'Abuja',
    });
  });

  it('never shows an id when the district name is missing', () => {
    const result = buildDispatchRequest(
      { ...base, service: 'Design', startDate: null, details: null },
      { districtName: null },
    );
    expect(result.districtName).not.toContain('district-1');
  });
});

describe('buildDispatchRequest from the live catalog', () => {
  const catalog = seededCatalog();
  const heavy = catalog.byId.get('svc:Hire/Heavy equipment')!;
  const trade = heavy.questions[0];
  const row = (over: Record<string, unknown> = {}) => ({
    ...base,
    service: 'Hire',
    serviceId: heavy.id,
    startDate: '2026-11-10',
    details: { trade: 'Excavator' },
    servicePath: [
      { id: 'svc:Hire', name: 'Hire' },
      { id: heavy.id, name: 'Heavy equipment' },
    ],
    answers: [
      {
        questionId: trade.id,
        key: 'trade',
        type: 'single_choice',
        value: 'Excavator',
        optionIds: [trade.options[0].id],
        matchesSkill: true,
      },
      {
        questionId: 'q-end',
        key: 'endDate',
        type: 'date',
        value: '2026-11-20',
        dateRole: 'end',
      },
    ],
    ...over,
  });

  it('takes the root and skill names from the catalog by id, so renames follow', () => {
    trade.options[0].label = 'Mini excavator';
    catalog.byId.get('svc:Hire')!.name = 'Hire and rental';
    const result = buildDispatchRequest(row(), locations, catalog);
    expect(result.service).toBe('Hire and rental');
    expect(result.skill).toBe('Mini excavator');
    expect(result.effectiveStartDate).toBe('2026-11-10');
    expect(result.effectiveEndDate).toBe('2026-11-20');
    trade.options[0].label = 'Excavator';
    catalog.byId.get('svc:Hire')!.name = 'Hire';
  });

  it('uses the leaf name when the path has no skill question', () => {
    const interior = catalog.byId.get('svc:Design/Interior design')!;
    const result = buildDispatchRequest(
      row({ service: 'Design', serviceId: interior.id, answers: [] }),
      locations,
      catalog,
    );
    expect(result.skill).toBe('Interior design');
    expect(result.service).toBe('Design');
  });

  it('falls back to the stored snapshot without a catalog and to details for legacy rows', () => {
    expect(buildDispatchRequest(row(), locations).skill).toBe('Excavator');
    expect(
      buildDispatchRequest(
        row({ serviceId: null, answers: [], details: { trade: 'Plumber' } }),
        locations,
        catalog,
      ).skill,
    ).toBe('Plumber');
  });
});

describe('buildDispatchRequest ids', () => {
  const heavy = 'svc:Hire/Heavy equipment';
  const excavator = `${heavy}:trade:Excavator`;
  const row = (over: Record<string, unknown> = {}) => ({
    ...base,
    service: 'Hire',
    serviceId: heavy,
    startDate: null,
    details: {},
    answers: [
      {
        questionId: `q:${heavy}:trade`,
        key: 'trade',
        type: 'single_choice',
        value: 'Excavator',
        optionIds: [excavator],
        matchesSkill: true,
      },
    ],
    ...over,
  });

  it('takes the root id and the answered option id', () => {
    expect(
      buildDispatchRequest(row(), locations, seededCatalog()),
    ).toMatchObject({
      service: 'Hire',
      serviceId: 'svc:Hire',
      skill: 'Excavator',
      skillId: excavator,
    });
  });

  it('takes the leaf id when the path has no skill question', () => {
    expect(
      buildDispatchRequest(
        row({
          service: 'Design',
          serviceId: 'svc:Design/Interior design',
          answers: [],
        }),
        locations,
        seededCatalog(),
      ),
    ).toMatchObject({
      serviceId: 'svc:Design',
      skill: 'Interior design',
      skillId: 'svc:Design/Interior design',
    });
  });

  it('has no skill id for a top-level service without a skill', () => {
    const catalog = seededCatalog();
    catalog.byId.get('svc:Design')!.children = [];
    expect(
      buildDispatchRequest(
        row({ service: 'Design', serviceId: 'svc:Design', answers: [] }),
        locations,
        catalog,
      ),
    ).toMatchObject({ serviceId: 'svc:Design', skill: null, skillId: null });
  });

  it('has no skill id when the answered option is gone', () => {
    const catalog = seededCatalog();
    catalog.byId.get(heavy)!.questions[0].options.shift();
    expect(buildDispatchRequest(row(), locations, catalog)).toMatchObject({
      skill: 'Excavator',
      skillId: null,
    });
  });

  it('resolves a legacy row with no serviceId from its stored names', () => {
    expect(
      buildDispatchRequest(
        row({
          serviceId: null,
          answers: [],
          details: { trade: 'Plumber' },
        }),
        locations,
        seededCatalog(),
      ),
    ).toMatchObject({
      service: 'Hire',
      serviceId: 'svc:Hire',
      skill: 'Plumber',
      skillId: 'svc:Hire/Vocational worker:trade:Plumber',
    });
  });

  it('resolves the stored names when the path no longer exists', () => {
    expect(
      buildDispatchRequest(
        row({ serviceId: 'deleted-leaf', details: {} }),
        locations,
        seededCatalog(),
      ),
    ).toMatchObject({
      service: 'Hire',
      serviceId: 'svc:Hire',
      skill: 'Excavator',
      skillId: excavator,
    });
  });

  it('has no ids for an unknown service name or without a catalog', () => {
    expect(
      buildDispatchRequest(
        row({ serviceId: null, service: 'Gardening', answers: [] }),
        locations,
        seededCatalog(),
      ),
    ).toMatchObject({ serviceId: null, skillId: null });
    expect(buildDispatchRequest(row(), locations)).toMatchObject({
      serviceId: null,
      skillId: null,
    });
  });

  describe('a provider holding ids survives renames with no cascade', () => {
    const provider: DispatchProvider = {
      id: 'provider-1',
      userId: 'provider-user-1',
      name: 'A Provider',
      verification: 'approved',
      userStatus: 'active',
      reliabilityStatus: 'normal',
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [excavator] },
      serviceAreaIds: ['district-1'],
      available: true,
      capacity: 3,
      committedJobs: 0,
      workingHours: {},
      timeOff: [],
      hasVerifiedCurrentBank: true,
      lastOfferedAt: null,
      experience: 5,
      reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 },
      earlierEndReasons: [],
    };
    const options = { requireVerifiedBank: true };

    it('is eligible after the option and the root are renamed', () => {
      const catalog = seededCatalog();
      expect(
        evaluateEligibility(
          provider,
          buildDispatchRequest(row(), locations, catalog),
          options,
        ),
      ).toEqual({ eligible: true });

      catalog.byId.get(heavy)!.questions[0].options[0].label =
        'Excavator (20t)';
      catalog.byId.get('svc:Hire')!.name = 'Hire and rental';
      const request = buildDispatchRequest(row(), locations, catalog);
      expect(request).toMatchObject({
        service: 'Hire and rental',
        skill: 'Excavator (20t)',
      });
      expect(evaluateEligibility(provider, request, options)).toEqual({
        eligible: true,
      });
    });

    it('is not eligible for a different option', () => {
      const other = row({
        answers: [
          {
            questionId: `q:${heavy}:trade`,
            key: 'trade',
            type: 'single_choice',
            value: 'Crane',
            optionIds: [`${heavy}:trade:Crane`],
            matchesSkill: true,
          },
        ],
      });
      expect(
        evaluateEligibility(
          provider,
          buildDispatchRequest(other, locations, seededCatalog()),
          options,
        ),
      ).toEqual({
        eligible: false,
        rule: 'skill',
        reason: 'Doesn’t offer Crane',
      });
    });
  });
});
