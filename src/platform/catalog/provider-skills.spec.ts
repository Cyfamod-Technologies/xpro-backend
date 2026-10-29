import { hireTradeGroups } from '../../scripts/legacy-service-catalog';
import { skillNames } from './catalog.views';
import { indexOf, makeNode, seededCatalog } from './catalog.testkit';
import {
  catalogNames,
  idsFromNames,
  namesFromIds,
  profileSkillIds,
  skillEntries,
} from './provider-skills';

const EXCAVATOR = 'svc:Hire/Heavy equipment:trade:Excavator';

describe('skillEntries', () => {
  it('produces exactly the names skillNames does, for every root of the seeded catalog', () => {
    const catalog = seededCatalog();
    for (const root of catalog.roots) {
      expect(skillEntries(root).map(({ name }) => name)).toEqual(
        skillNames(root),
      );
      expect(skillEntries(root).every(({ rootId }) => rootId === root.id)).toBe(
        true,
      );
    }
  });

  it('uses option ids for a skill question and node ids for skill leaves', () => {
    const catalog = seededCatalog();
    const hire = skillEntries(catalog.byId.get('svc:Hire')!);
    expect(hire).toHaveLength(Object.values(hireTradeGroups).flat().length);
    expect(hire).toContainEqual({
      id: EXCAVATOR,
      name: 'Excavator',
      rootId: 'svc:Hire',
    });
    expect(skillEntries(catalog.byId.get('svc:Design')!)).toContainEqual({
      id: 'svc:Design/Interior design',
      name: 'Interior design',
      rootId: 'svc:Design',
    });
  });

  it('gives nothing for a root with no sub-services and no skill question', () => {
    expect(skillEntries(makeNode({ id: 'solo', name: 'Solo' }))).toEqual([]);
  });

  it('does not offer a leaf that sits below a skill question', () => {
    const root = makeNode({
      id: 'r',
      name: 'Root',
      children: [
        makeNode({
          id: 'r/group',
          name: 'Group',
          parentId: 'r',
          depth: 1,
          questions: [
            {
              key: 'kind',
              type: 'single_choice',
              matchesSkill: true,
              options: [{ id: 'o1', label: 'Kind one', active: true }],
            },
          ],
          children: [makeNode({ id: 'r/group/leaf', name: 'Deep', depth: 2 })],
        }),
      ],
    });
    expect(skillEntries(root).map(({ id }) => id)).toEqual(['o1']);
  });

  describe('activeOnly', () => {
    it('skips inactive nodes, questions and options', () => {
      const catalog = seededCatalog();
      catalog.byId.get('svc:Design/Interior design')!.active = false;
      const heavy = catalog.byId.get('svc:Hire/Heavy equipment')!;
      heavy.questions[0].options[0].active = false;
      catalog.byId.get('svc:Hire/Professional')!.active = false;

      const all = skillEntries(catalog.byId.get('svc:Hire')!).map(
        ({ id }) => id,
      );
      const active = skillEntries(catalog.byId.get('svc:Hire')!, {
        activeOnly: true,
      }).map(({ id }) => id);
      expect(all).toContain(EXCAVATOR);
      expect(active).not.toContain(EXCAVATOR);
      expect(active).toHaveLength(
        Object.values(hireTradeGroups).flat().length - 7 - 1,
      );
      expect(
        skillEntries(catalog.byId.get('svc:Design')!, { activeOnly: true }).map(
          ({ name }) => name,
        ),
      ).toEqual(['Architectural plan', 'Structural plan']);
    });

    it('treats a node whose children are all inactive as a leaf', () => {
      const parent = makeNode({
        id: 'p',
        name: 'Parent',
        children: [
          makeNode({
            id: 'p/mid',
            name: 'Mid',
            parentId: 'p',
            depth: 1,
            children: [
              makeNode({
                id: 'p/mid/old',
                name: 'Old',
                parentId: 'p/mid',
                depth: 2,
                active: false,
              }),
            ],
          }),
        ],
      });
      expect(skillEntries(parent).map(({ id }) => id)).toEqual(['p/mid/old']);
      expect(skillEntries(parent, { activeOnly: true })).toEqual([
        { id: 'p/mid', name: 'Mid', rootId: 'p' },
      ]);
    });
  });
});

describe('catalogNames', () => {
  it('names every node and option, inactive ones included', () => {
    const catalog = seededCatalog();
    catalog.byId.get('svc:Hire/Heavy equipment')!.active = false;
    catalog.byId.get(
      'svc:Hire/Heavy equipment',
    )!.questions[0].options[0].active = false;
    const names = catalogNames(catalog);
    expect(names.get('svc:Hire')).toBe('Hire');
    expect(names.get('svc:Hire/Heavy equipment')).toBe('Heavy equipment');
    expect(names.get(EXCAVATOR)).toBe('Excavator');
    expect(names.get('delivery:Design only')).toBe('Design only');
  });
});

describe('idsFromNames and namesFromIds', () => {
  const catalog = seededCatalog();

  it('round-trips names through ids', () => {
    const skills = {
      Hire: ['Excavator', 'Mason'],
      Design: ['Interior design'],
    };
    const ids = idsFromNames(catalog, ['Hire', 'Design'], skills);
    expect(ids).toEqual({
      serviceIds: ['svc:Hire', 'svc:Design'],
      skillIds: {
        'svc:Hire': [EXCAVATOR, 'svc:Hire/Vocational worker:trade:Mason'],
        'svc:Design': ['svc:Design/Interior design'],
      },
      unmatched: [],
    });
    expect(namesFromIds(catalog, ids.serviceIds, ids.skillIds)).toEqual({
      services: ['Hire', 'Design'],
      skills,
    });
  });

  it('matches case-insensitively and trimmed after an exact match fails', () => {
    expect(
      idsFromNames(catalog, [' hire '], { ' hire ': [' excavator '] }),
    ).toMatchObject({
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [EXCAVATOR] },
      unmatched: [],
    });
  });

  it('matches inactive entries, so a deactivated skill still maps', () => {
    const tree = seededCatalog();
    tree.byId.get('svc:Design/Interior design')!.active = false;
    expect(
      idsFromNames(tree, ['Design'], { Design: ['Interior design'] }).skillIds,
    ).toEqual({ 'svc:Design': ['svc:Design/Interior design'] });
  });

  it('reports names that match nothing and still returns the ids that matched', () => {
    expect(
      idsFromNames(catalog, ['Hire', 'Plumbing'], {
        Hire: ['Excavator', 'Wizard'],
        Plumbing: ['Pipes'],
      }),
    ).toEqual({
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [EXCAVATOR] },
      unmatched: ['Hire › Wizard', 'Plumbing'],
    });
  });

  it('looks a skill up only under its own root', () => {
    expect(
      idsFromNames(catalog, ['Design'], { Design: ['Excavator'] }),
    ).toMatchObject({
      skillIds: { 'svc:Design': [] },
      unmatched: ['Design › Excavator'],
    });
  });

  it('keeps every id when two entries under a root share a name', () => {
    const root = makeNode({
      id: 'r',
      name: 'Root',
      children: ['a', 'b'].map((key, index) =>
        makeNode({
          id: `r/${key}`,
          name: key,
          parentId: 'r',
          depth: 1,
          sortOrder: index,
          questions: [
            {
              key: 'kind',
              type: 'single_choice',
              matchesSkill: true,
              options: [{ id: `o-${key}`, label: 'Operator', active: true }],
            },
          ],
        }),
      ),
    });
    const tree = indexOf([root]);
    const ids = idsFromNames(tree, ['Root'], { Root: ['Operator'] });
    expect(ids.skillIds.r).toEqual(['o-a', 'o-b']);
    expect(namesFromIds(tree, ids.serviceIds, ids.skillIds).skills).toEqual({
      Root: ['Operator'],
    });
  });

  it('ignores a legacy empty-array skills value', () => {
    expect(idsFromNames(catalog, ['Design'], [])).toEqual({
      serviceIds: ['svc:Design'],
      skillIds: { 'svc:Design': [] },
      unmatched: [],
    });
  });

  it('drops ids the catalog no longer knows, and shows the current names', () => {
    const tree = seededCatalog();
    tree.byId.get('svc:Hire/Heavy equipment')!.questions[0].options[0].label =
      'Excavator (20t)';
    expect(
      namesFromIds(tree, ['svc:Hire', 'gone'], {
        'svc:Hire': [EXCAVATOR, 'deleted-option'],
        gone: ['x'],
      }),
    ).toEqual({
      services: ['Hire'],
      skills: { Hire: ['Excavator (20t)'] },
    });
  });
});

describe('profileSkillIds', () => {
  const catalog = seededCatalog();

  it('returns the stored ids when the profile has them, whatever its names say', () => {
    expect(
      profileSkillIds(catalog, {
        serviceIds: ['svc:Hire'],
        skillIds: { 'svc:Hire': [EXCAVATOR] },
        services: ['Design'],
        skills: { Design: ['Interior design'] },
      }),
    ).toEqual({
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [EXCAVATOR] },
    });
  });

  it('falls back to the names while the ids are null or missing', () => {
    const expected = {
      serviceIds: ['svc:Design'],
      skillIds: { 'svc:Design': ['svc:Design/Interior design'] },
    };
    const names = {
      services: ['Design'],
      skills: { Design: ['Interior design'] },
    };
    expect(
      profileSkillIds(catalog, { ...names, serviceIds: null, skillIds: null }),
    ).toEqual(expected);
    expect(profileSkillIds(catalog, names)).toEqual(expected);
    expect(
      profileSkillIds(catalog, {
        ...names,
        serviceIds: ['svc:Hire'],
        skillIds: null,
      }),
    ).toEqual(expected);
  });
});
