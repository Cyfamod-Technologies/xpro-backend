import { buildDispatchRequest } from './dispatch-request';

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
