import {
  choice,
  indexOf,
  makeNode,
  resolvedFor,
  seededCatalog,
} from '../../platform/catalog/catalog.testkit';
import { resolveServiceInput } from './legacy-service-input';
import { validateIntake, normalizeNigerianPhone } from './intake-validation';

const place = (
  id: string,
  kind: string,
  ancestorIds: string[],
  extra: { active?: boolean; serviceable?: boolean } = {},
) => ({ id, kind, ancestorIds, active: true, serviceable: true, ...extra });
// The chosen place and its ancestors, as `loadLocationChain` returns them.
const locations = [
  place('state', 'state', []),
  place('lga', 'lga', ['state']),
  place('area', 'area', ['state', 'lga']),
];
const now = new Date('2026-10-23T12:00:00Z');
const catalog = seededCatalog();

function valid(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Repair a leaking roof',
    service: 'Construction',
    locationId: 'area',
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

const run = (input: Record<string, unknown>, at = now) =>
  validateIntake(input, resolveServiceInput(catalog, input), locations, at);

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
    [valid({ locationId: 'missing' }), 'Choose your location from the list.'],
    [valid({ locationId: undefined }), 'Choose your location from the list.'],
    [valid({ locationId: 'state' }), 'Choose your location from the list.'],
    [valid({ address: '' }), 'Complete your contact and site details.'],
    [valid({ phone: '555' }), 'Enter a valid Nigerian phone number.'],
    [
      valid({ contactMethod: 'sms' }),
      'Choose how XPro should contact you: email, phone or both.',
    ],
    [valid({ budget: -1 }), 'Budget must be zero or a positive amount.'],
    [valid({ details: { workType: '' } }), 'Choose a valid service.'],
    [valid({ details: { workType: 'Wrong' } }), 'Choose a valid service.'],
    [
      valid({ details: { workType: 'Roof and ceiling', area: 0 } }),
      'Approximate area (sqm) must be positive.',
    ],
    [
      valid({
        service: 'Hiring',
        details: { trade: 'Wrong', endDate: '2026-10-30' },
      }),
      'Choose a valid service.',
    ],
    [
      valid({
        service: 'Hiring',
        details: { trade: 'Mason', endDate: '2026-10-30' },
      }),
      'Complete quantity.',
    ],
    [
      valid({
        service: 'Waste Management',
        details: {
          wasteType: 'Residential',
          quantity: '2 loads',
          access: 'Gate code at the front desk',
          pickupDate: 'not-a-date',
        },
      }),
      'Preferred pickup date must be a valid date.',
    ],
    [
      valid({
        service: 'Hiring',
        details: { trade: 'Mason', quantity: 1, endDate: '2026-13-45' },
      }),
      'Hire end date must be a valid date.',
    ],
    [
      valid({
        service: 'Hiring',
        details: { trade: 'Mason', quantity: 1, endDate: '2026-10-30' },
      }),
      'Add the hire start date.',
    ],
    [
      valid({
        service: 'Hiring',
        startDate: '2026-10-25',
        details: { trade: 'Architect', quantity: 1, endDate: '2026-10-24' },
      }),
      'Hire end date cannot be before the start date.',
    ],
    [
      valid({
        service: 'Hiring',
        startDate: '2026-10-25',
        details: { trade: 'Architect', quantity: 0, endDate: '2026-10-30' },
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
    expect(() => run(input)).toThrow(message);
  });

  describe('location', () => {
    it('accepts a served area or a served LGA', () => {
      expect(run(valid()).locationId).toBe('area');
      expect(run(valid({ locationId: 'lga' })).locationId).toBe('lga');
    });

    it.each([
      ['the place is not serviceable', 'area', { serviceable: false }],
      ['the place is inactive', 'area', { active: false }],
      ['an ancestor is not serviceable', 'lga', { serviceable: false }],
      ['an ancestor is inactive', 'state', { active: false }],
    ])('refuses a place when %s', (_label, id, change) => {
      const chain = locations.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      );
      expect(() =>
        validateIntake(
          valid(),
          resolveServiceInput(catalog, valid()),
          chain,
          now,
        ),
      ).toThrow('Choose your location from the list.');
    });

    it('refuses a state even when it is served', () => {
      expect(() => run(valid({ locationId: 'state' }))).toThrow(
        'Choose your location from the list.',
      );
    });
  });

  it('fails with a missing service when nothing resolves', () => {
    expect(() => validateIntake(valid(), null, locations, now)).toThrow(
      'Choose a valid service.',
    );
  });

  it('normalises Nigerian phone forms to E.164', () => {
    expect(normalizeNigerianPhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalizeNigerianPhone('2348031234567')).toBe('+2348031234567');
    expect(normalizeNigerianPhone('+2348031234567')).toBe('+2348031234567');
  });

  it('uses the WAT calendar day for date-window boundaries', () => {
    const at = new Date('2026-10-22T23:30:00.000Z'); // 00:30 on 23 Oct in WAT
    expect(run(valid({ startDate: '2026-10-23' }), at).startDate).toBe(
      '2026-10-23',
    );
    expect(() => run(valid({ startDate: '2026-10-22' }), at)).toThrow(
      'Choose a date from today onwards.',
    );
    expect(run(valid({ startDate: '2027-10-23' }), at).startDate).toBe(
      '2027-10-23',
    );
    expect(() => run(valid({ startDate: '2027-10-24' }), at)).toThrow(
      'Choose a date within the next 12 months.',
    );
  });

  it('trims details to the selected service and detects contact details in the brief', () => {
    const result = run(
      valid({ description: 'Call me at 08031234567 before arriving.' }),
    );
    expect(result.details).toEqual({ area: 42 });
    expect(result.contactInBrief).toBe(true);
    expect(result.service).toBe('Construction');
    expect(result.skill).toBe('Roof and ceiling');
    expect(result.servicePath.map(({ name }) => name)).toEqual([
      'Construction',
      'Roof and ceiling',
    ]);
  });

  describe('catalog answers', () => {
    const heavy = 'svc:Hiring/Heavy equipment';
    const heavyTrade = catalog.byId
      .get(heavy)!
      .questions.find(({ key }) => key === 'trade')!;
    const operator = catalog.byId.get(heavy)!.questions[1];
    const quantity = catalog.byId
      .get('svc:Hiring')!
      .questions.find(({ key }) => key === 'quantity')!;
    const endDate = catalog.byId
      .get('svc:Hiring')!
      .questions.find(({ key }) => key === 'endDate')!;
    const input = (answers: Record<string, unknown>, extra = {}) => ({
      ...valid({ details: undefined, ...extra }),
      serviceId: heavy,
      service: undefined,
      startDate: '2026-10-25',
      answers,
    });
    const complete = {
      [heavyTrade.id]: heavyTrade.options[0].id,
      [operator.id]: 'Yes',
      [quantity.id]: 2,
      [endDate.id]: '2026-10-30',
    };
    const check = (value: Record<string, unknown>) =>
      validateIntake(
        value,
        resolveServiceInput(catalog, value),
        locations,
        now,
      );

    it('stores the snapshot, details, skill and dates for a leaf', () => {
      const result = check(input(complete));
      expect(result.serviceId).toBe(heavy);
      expect(result.serviceRootId).toBe('svc:Hiring');
      expect(result.skill).toBe('Excavator');
      expect(result.details).toEqual({
        trade: 'Excavator',
        operator: 'Yes',
        quantity: 2,
        endDate: '2026-10-30',
      });
      expect(result.effectiveStartDate).toBe('2026-10-25');
      expect(result.effectiveEndDate).toBe('2026-10-30');
      expect(result.answers.map(({ key }) => key)).toEqual([
        'quantity',
        'endDate',
        'trade',
        'operator',
      ]);
      expect(result.answers[2]).toEqual({
        questionId: heavyTrade.id,
        serviceId: heavy,
        serviceName: 'Heavy equipment',
        key: 'trade',
        label: 'Equipment required',
        type: 'single_choice',
        value: 'Excavator',
        display: 'Excavator',
        optionIds: [heavyTrade.options[0].id],
        sensitive: false,
        matchesSkill: true,
      });
      expect(result.answers[1]).toMatchObject({
        type: 'date',
        dateRole: 'end',
        matchesSkill: false,
      });
    });

    it.each([
      [
        'a missing required answer',
        { ...complete, [heavyTrade.id]: '' },
        'Complete equipment required.',
      ],
      [
        'an unknown option',
        { ...complete, [heavyTrade.id]: 'Wrong' },
        'Choose a valid equipment required.',
      ],
      [
        'a yes/no outside Yes and No',
        { ...complete, [operator.id]: 'Maybe' },
        'Choose a valid operator required?.',
      ],
      [
        'a fractional quantity',
        { ...complete, [quantity.id]: 1.5 },
        'Quantity must be a whole number from 1 to 10.',
      ],
    ])('rejects %s', (_name, answers, message) => {
      expect(() => check(input(answers))).toThrow(message);
    });

    it('treats a sub-service the customer did not pick as invalid', () => {
      expect(() =>
        check({ ...input(complete), serviceId: 'svc:Hiring' }),
      ).toThrow('Choose a valid service.');
    });

    it('rejects an inactive service path but can ignore it for an unchanged edit', () => {
      const tree = seededCatalog();
      tree.byId.get(heavy)!.active = false;
      const value = input(complete);
      expect(() =>
        validateIntake(value, resolveServiceInput(tree, value), locations, now),
      ).toThrow('Choose a valid service.');
      const resolved = resolveServiceInput(tree, value, {
        includeInactive: true,
      });
      expect(validateIntake(value, resolved, locations, now).serviceId).toBe(
        heavy,
      );
    });
  });

  describe('question types', () => {
    const service = makeNode({
      id: 'svc:Custom',
      name: 'Custom',
      requiresStartDate: true,
      questions: [
        {
          key: 'pick',
          label: 'Pick one',
          type: 'single_choice',
          required: true,
          options: choice('pick', ['A', 'B']),
        },
        {
          key: 'many',
          label: 'Pick many',
          type: 'multiple_choice',
          required: true,
          options: choice('many', ['X', 'Y', 'Z']),
        },
        {
          key: 'note',
          label: 'Note',
          type: 'short_text',
          config: { minLength: 2, maxLength: 5 },
        },
        {
          key: 'count',
          label: 'Count',
          type: 'number',
          config: { min: 1, max: 9 },
        },
        { key: 'from', label: 'From', type: 'date', dateRole: 'start' },
        { key: 'until', label: 'Until', type: 'date', dateRole: 'end' },
      ],
    });
    const custom = indexOf([service]);
    const q = (key: string) =>
      service.questions.find((item) => item.key === key)!;
    const base = {
      ...valid({ details: undefined, service: undefined }),
      serviceId: 'svc:Custom',
    };
    const answers = {
      [q('pick').id]: 'pick:A',
      [q('many').id]: ['many:X', 'many:Z'],
    };
    const check = (extra: Record<string, unknown>, more = {}) =>
      validateIntake(
        { ...base, ...more, answers: { ...answers, ...extra } },
        resolvedFor(custom, 'svc:Custom'),
        locations,
        now,
      );

    it('requires the start date from requiresStartDate on the path', () => {
      expect(() => check({})).toThrow('Add the start date.');
      expect(check({ [q('from').id]: '2026-11-01' }).effectiveStartDate).toBe(
        '2026-11-01',
      );
      expect(check({}, { startDate: '2026-11-02' }).effectiveStartDate).toBe(
        '2026-11-02',
      );
    });

    it('stores multiple choices as labels and ids', () => {
      const result = check({}, { startDate: '2026-11-02' });
      expect(result.details.many).toEqual(['X', 'Z']);
      expect(result.answers[1]).toMatchObject({
        value: ['X', 'Z'],
        display: 'X, Z',
        optionIds: ['many:X', 'many:Z'],
      });
    });

    it.each([
      [{ [q('many').id]: [] }, 'Complete pick many.'],
      [{ [q('many').id]: ['many:X', 'many:X'] }, 'Choose a valid pick many.'],
      [{ [q('many').id]: ['nope'] }, 'Choose a valid pick many.'],
      [{ [q('note').id]: 'x' }, 'Complete note.'],
      [{ [q('note').id]: 'toolong' }, 'Complete note.'],
      [{ [q('count').id]: 10 }, 'Count must be a number from 1 to 9.'],
      [{ [q('count').id]: 'abc' }, 'Count must be a number from 1 to 9.'],
      [
        { [q('until').id]: '2026-11-01', [q('from').id]: '2026-11-05' },
        'End date cannot be before the start date.',
      ],
      [{ [q('from').id]: '2026-02-30' }, 'From must be a valid date.'],
    ])('rejects %j', (extra, message) => {
      expect(() => check(extra, { startDate: '2026-11-02' })).toThrow(message);
    });

    it('rejects a deactivated option', () => {
      service.questions[0].options[0].active = false;
      expect(() => check({}, { startDate: '2026-11-02' })).toThrow(
        'Choose a valid pick one.',
      );
      service.questions[0].options[0].active = true;
    });
  });
});
