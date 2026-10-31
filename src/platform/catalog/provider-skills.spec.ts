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

const EXCAVATOR = 'svc:Hiring/Heavy equipment:trade:Excavator';

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
    const hire = skillEntries(catalog.byId.get('svc:Hiring')!);
    expect(hire).toHaveLength(Object.values(hireTradeGroups).flat().length);
    expect(hire).toContainEqual({
      id: EXCAVATOR,
      name: 'Excavator',
      rootId: 'svc:Hiring',
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
      const heavy = catalog.byId.get('svc:Hiring/Heavy equipment')!;
      heavy.questions[0].options[0].active = false;
      catalog.byId.get('svc:Hiring/Professional')!.active = false;

      const all = skillEntries(catalog.byId.get('svc:Hiring')!).map(
        ({ id }) => id,
      );
      const active = skillEntries(catalog.byId.get('svc:Hiring')!, {
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
    catalog.byId.get('svc:Hiring/Heavy equipment')!.active = false;
    catalog.byId.get(
      'svc:Hiring/Heavy equipment',
    )!.questions[0].options[0].active = false;
    const names = catalogNames(catalog);
    expect(names.get('svc:Hiring')).toBe('Hiring');
    expect(names.get('svc:Hiring/Heavy equipment')).toBe('Heavy equipment');
    expect(names.get(EXCAVATOR)).toBe('Excavator');
    expect(names.get('delivery:Design only')).toBe('Design only');
  });
});

describe('idsFromNames and namesFromIds', () => {
  const catalog = seededCatalog();

  it('round-trips names through ids', () => {
    const skills = {
      Hiring: ['Excavator', 'Mason'],
      Design: ['Interior design'],
    };
    const ids = idsFromNames(catalog, ['Hiring', 'Design'], skills);
    expect(ids).toEqual({
      serviceIds: ['svc:Hiring', 'svc:Design'],
      skillIds: {
        'svc:Hiring': [EXCAVATOR, 'svc:Hiring/Vocational worker:trade:Mason'],
        'svc:Design': ['svc:Design/Interior design'],
      },
      unmatched: [],
    });
    expect(namesFromIds(catalog, ids.serviceIds, ids.skillIds)).toEqual({
      services: ['Hiring', 'Design'],
      skills,
    });
  });

  it('matches case-insensitively and trimmed after an exact match fails', () => {
    expect(
      idsFromNames(catalog, [' hiring '], { ' hiring ': [' excavator '] }),
    ).toMatchObject({
      serviceIds: ['svc:Hiring'],
      skillIds: { 'svc:Hiring': [EXCAVATOR] },
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
      idsFromNames(catalog, ['Hiring', 'Plumbing'], {
        Hiring: ['Excavator', 'Wizard'],
        Plumbing: ['Pipes'],
      }),
    ).toEqual({
      serviceIds: ['svc:Hiring'],
      skillIds: { 'svc:Hiring': [EXCAVATOR] },
      unmatched: ['Hiring › Wizard', 'Plumbing'],
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
    tree.byId.get('svc:Hiring/Heavy equipment')!.questions[0].options[0].label =
      'Excavator (20t)';
    expect(
      namesFromIds(tree, ['svc:Hiring', 'gone'], {
        'svc:Hiring': [EXCAVATOR, 'deleted-option'],
        gone: ['x'],
      }),
    ).toEqual({
      services: ['Hiring'],
      skills: { Hiring: ['Excavator (20t)'] },
    });
  });
});

describe('profileSkillIds', () => {
  const catalog = seededCatalog();

  it('returns the stored ids when the profile has them, whatever its names say', () => {
    expect(
      profileSkillIds(catalog, {
        serviceIds: ['svc:Hiring'],
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        services: ['Design'],
        skills: { Design: ['Interior design'] },
      }),
    ).toEqual({
      serviceIds: ['svc:Hiring'],
      skillIds: { 'svc:Hiring': [EXCAVATOR] },
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
        serviceIds: ['svc:Hiring'],
        skillIds: null,
      }),
    ).toEqual(expected);
  });
});
