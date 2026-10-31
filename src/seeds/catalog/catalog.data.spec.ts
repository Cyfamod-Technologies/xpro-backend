import {
  CATALOG_QUESTIONS,
  CATALOG_SERVICES,
  DEACTIVATED_QUESTION_IDS,
  EXPANDED_GROUPS,
  RENAMED_ROOTS,
  RETIRED_SERVICES,
  type SeedService,
} from './catalog.data';

const all = (nodes: readonly SeedService[]): SeedService[] =>
  nodes.flatMap((node) => [node, ...all(node.children ?? [])]);

const root = (name: string) => CATALOG_SERVICES.find((r) => r.name === name)!;

describe('catalog seed data', () => {
  it('lists the five website roots', () => {
    expect(CATALOG_SERVICES.map(({ name }) => name)).toEqual([
      'Design',
      'Construction',
      'Hiring',
      'Facility Management',
      'Waste Management',
    ]);
  });

  it('gives every node a unique id and unique sibling names', () => {
    const nodes = all(CATALOG_SERVICES);
    expect(new Set(nodes.map(({ id }) => id)).size).toBe(nodes.length);
    const sameParent = (list: readonly SeedService[]) => {
      const names = list.map(({ name }) => name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      list.forEach(({ children }) => sameParent(children ?? []));
    };
    sameParent(CATALOG_SERVICES);
    expect(
      nodes.every(({ name }) => name.length >= 2 && name.length <= 80),
    ).toBe(true);
  });

  it('builds Construction from six groups of six leaves', () => {
    const groups = root('Construction').children!;
    expect(groups).toHaveLength(6);
    expect(groups.map(({ children }) => children!.length)).toEqual([
      6, 6, 6, 6, 6, 6,
    ]);
  });

  it('turns the Hiring trades into 19, 20 and 19 leaves', () => {
    expect(
      root('Hiring').children!.map(({ children }) => children!.length),
    ).toEqual([19, 20, 19]);
  });

  it('keeps retired nodes out of the tree and the expanded groups inside it', () => {
    const ids = new Set(all(CATALOG_SERVICES).map(({ id }) => id));
    expect(RETIRED_SERVICES.some(({ id }) => ids.has(id))).toBe(false);
    expect(EXPANDED_GROUPS.groupIds.every((id) => ids.has(id))).toBe(true);
    expect(RETIRED_SERVICES.map(({ name }) => name).slice(-3)).toEqual([
      'Renovation',
      'Routine maintenance',
      'Procurement',
    ]);
  });

  it('names each renamed root as the tree does', () => {
    for (const { id, to } of RENAMED_ROOTS)
      expect(CATALOG_SERVICES.find((r) => r.id === id)?.name).toBe(to);
  });

  it('keeps questions only on services in the tree, with no skill question', () => {
    const ids = new Set(all(CATALOG_SERVICES).map(({ id }) => id));
    expect(CATALOG_QUESTIONS.every(({ serviceId }) => ids.has(serviceId))).toBe(
      true,
    );
    expect(
      CATALOG_QUESTIONS.some(({ id }) => DEACTIVATED_QUESTION_IDS.includes(id)),
    ).toBe(false);
    expect(DEACTIVATED_QUESTION_IDS).toHaveLength(3);
  });
});
