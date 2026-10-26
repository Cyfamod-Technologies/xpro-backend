import { intakeFields } from '../../platform/catalog/service-lines';
import { validateIntake, normalizeNigerianPhone } from './intake-validation';

const locations = [
  { id: 'city', kind: 'city', parentId: null, active: true },
  { id: 'district', kind: 'district', parentId: 'city', active: true },
];

function valid(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Repair a leaking roof',
    service: 'Construction',
    cityId: 'city',
    districtId: 'district',
    address: '12 Broad Street, Lagos',
    phone: '08031234567',
    contactMethod: 'phone',
    description:
      'Water enters through two areas of the roof whenever it rains.',
    budget: 0,
    details: { workType: 'Roof and ceiling', area: 42, ignored: 'trimmed' },
    attachments: [],
    ...overrides,
  };
}

describe('validateIntake', () => {
  it.each([
    [
      valid({ title: 'no' }),
      'Add a title and a project brief of at least 20 characters.',
    ],
    [valid({ service: 'Other' }), 'Choose a valid service.'],
    [
      valid({ providerId: 'provider' }),
      'XPro assigns a verified provider for you. Remove the provider preference.',
    ],
    [
      valid({ cityId: 'missing' }),
      'Choose your city and district from the list.',
    ],
    [
      valid({ districtId: 'city' }),
      'Choose your city and district from the list.',
    ],
    [valid({ address: '' }), 'Complete your contact and site details.'],
    [valid({ phone: '555' }), 'Enter a valid Nigerian phone number.'],
    [
      valid({ contactMethod: 'sms' }),
      'Choose how XPro should contact you: email, phone or both.',
    ],
    [valid({ budget: -1 }), 'Budget must be zero or a positive amount.'],
    [valid({ details: { workType: '' } }), 'Complete work required.'],
    [
      valid({ details: { workType: 'Wrong' } }),
      'Choose a valid work required.',
    ],
    [
      valid({ details: { workType: 'Roof and ceiling', area: 0 } }),
      'Approximate area (sqm) must be positive.',
    ],
    [
      valid({
        service: 'Hire',
        details: {
          hireType: 'Professional',
          trade: 'Wrong',
          endDate: '2026-10-30',
        },
      }),
      'Complete quantity.',
    ],
    [
      valid({
        service: 'Procurement',
        details: {
          materials: 'cement bags',
          category: 'not a category',
          deliveryDate: '2026-10-30',
        },
      }),
      'Choose a valid material category.',
    ],
    [
      valid({
        service: 'Procurement',
        details: {
          materials: 'cement bags',
          category: 'Cement and blocks',
          deliveryDate: 'not-a-date',
        },
      }),
      'Required delivery date must be a valid date.',
    ],
    [
      valid({
        service: 'Hire',
        details: {
          hireType: 'Professional',
          trade: 'Mason',
          quantity: 1,
          endDate: '2026-13-45',
        },
      }),
      'Hire end date must be a valid date.',
    ],
    [
      valid({
        service: 'Hire',
        details: {
          hireType: 'Professional',
          trade: 'Mason',
          quantity: 1,
          endDate: '2026-10-30',
        },
      }),
      'Add the hire start date.',
    ],
    [
      valid({
        service: 'Hire',
        details: {
          hireType: 'Professional',
          trade: 'Mason',
          quantity: 11,
          endDate: '2026-10-30',
        },
      }),
      'Add the hire start date.',
    ],
    [
      valid({
        service: 'Hire',
        startDate: '2026-10-25',
        details: {
          hireType: 'Professional',
          trade: 'Architect',
          quantity: 1,
          endDate: '2026-10-24',
        },
      }),
      'Hire end date cannot be before the start date.',
    ],
    [
      valid({
        service: 'Hire',
        startDate: '2026-10-25',
        details: {
          hireType: 'Professional',
          trade: 'Mason',
          quantity: 1,
          endDate: '2026-10-30',
        },
      }),
      'Choose a trade or equipment type that matches the hire category.',
    ],
    [
      valid({
        service: 'Hire',
        startDate: '2026-10-25',
        details: {
          hireType: 'Professional',
          trade: 'Architect',
          quantity: 0,
          endDate: '2026-10-30',
        },
      }),
      'Quantity must be a whole number from 1 to 10.',
    ],
    [
      valid({
        attachments: Array.from({ length: 21 }, (_, index) => `id-${index}`),
      }),
      'A request can hold up to 20 files. Remove one before adding more.',
    ],
  ])('returns the first failure in spec order', (input, message) => {
    expect(() =>
      validateIntake(
        input,
        intakeFields,
        locations,
        new Date('2026-10-23T12:00:00Z'),
      ),
    ).toThrow(message);
  });

  it('normalises Nigerian phone forms to E.164', () => {
    expect(normalizeNigerianPhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalizeNigerianPhone('2348031234567')).toBe('+2348031234567');
    expect(normalizeNigerianPhone('+2348031234567')).toBe('+2348031234567');
  });

  it('uses the WAT calendar day for date-window boundaries', () => {
    const now = new Date('2026-10-22T23:30:00.000Z'); // 00:30 on 23 Oct in WAT
    expect(
      validateIntake(
        valid({ startDate: '2026-10-23' }),
        intakeFields,
        locations,
        now,
      ).startDate,
    ).toBe('2026-10-23');
    expect(() =>
      validateIntake(
        valid({ startDate: '2026-10-22' }),
        intakeFields,
        locations,
        now,
      ),
    ).toThrow('Choose a date from today onwards.');
    expect(
      validateIntake(
        valid({ startDate: '2027-10-23' }),
        intakeFields,
        locations,
        now,
      ).startDate,
    ).toBe('2027-10-23');
    expect(() =>
      validateIntake(
        valid({ startDate: '2027-10-24' }),
        intakeFields,
        locations,
        now,
      ),
    ).toThrow('Choose a date within the next 12 months.');
  });

  it('trims details to the selected service and detects contact details in the brief', () => {
    const result = validateIntake(
      valid({ description: 'Call me at 08031234567 before arriving.' }),
      intakeFields,
      locations,
      new Date('2026-10-23T12:00:00Z'),
    );
    expect(result.details).toEqual({ workType: 'Roof and ceiling', area: 42 });
    expect(result.contactInBrief).toBe(true);
  });

  it('rejects a Hire trade outside its selected category after date checks', () => {
    expect(() =>
      validateIntake(
        valid({
          service: 'Hire',
          startDate: '2026-10-25',
          details: {
            hireType: 'Professional',
            trade: 'Mason',
            quantity: 1,
            endDate: '2026-10-30',
          },
        }),
        intakeFields,
        locations,
        new Date('2026-10-23T12:00:00Z'),
      ),
    ).toThrow(
      'Choose a trade or equipment type that matches the hire category.',
    );
  });
});
