import { indexOf, makeNode } from '../../platform/catalog/catalog.testkit';
import { legacySkill, resolveServiceInput } from './legacy-service-input';

const crane = makeNode({
  id: 'crane',
  name: 'Crane',
  parentId: 'heavy',
  depth: 2,
});
const heavy = makeNode({
  id: 'heavy',
  name: 'Heavy Equipment',
  parentId: 'hiring',
  depth: 1,
  children: [crane],
});
const hiring = makeNode({ id: 'hiring', name: 'Hiring', children: [heavy] });
const waste = makeNode({ id: 'waste', name: 'Waste Management' });
const catalog = indexOf([hiring, waste]);

describe('resolveServiceInput', () => {
  it.each(['Hire', 'Hiring'])(
    'resolves the %s service and its trade to the leaf',
    (service) => {
      const resolved = resolveServiceInput(catalog, {
        service,
        details: { trade: 'crane' },
      });
      expect(resolved?.path.map(({ id }) => id)).toEqual([
        'hiring',
        'heavy',
        'crane',
      ]);
    },
  );

  it.each(['Waste management', 'Waste Management'])(
    'resolves the %s root',
    (service) => {
      expect(
        resolveServiceInput(catalog, { service })?.path.map(({ id }) => id),
      ).toEqual(['waste']);
    },
  );

  it('returns null for a service that no longer exists', () => {
    expect(resolveServiceInput(catalog, { service: 'Procurement' })).toBeNull();
  });
});

describe('legacySkill', () => {
  it('reads the skill key of both the old and the new service name', () => {
    expect(legacySkill('Hire', { trade: 'Mason' })).toBe('Mason');
    expect(legacySkill('Hiring', { trade: 'Mason' })).toBe('Mason');
    expect(
      legacySkill('Facility management', { serviceNeeds: 'Repairs' }),
    ).toBe('Repairs');
  });
});
