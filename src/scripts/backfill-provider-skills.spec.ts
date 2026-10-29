import { seededCatalog } from '../platform/catalog/catalog.testkit';
import { backfillSkills, type ProfileSkills } from './backfill-provider-skills';

const EXCAVATOR = 'svc:Hire/Heavy equipment:trade:Excavator';
const MASON = 'svc:Hire/Vocational worker:trade:Mason';

const profile = (over: Partial<ProfileSkills> = {}): ProfileSkills => ({
  services: ['Hire', 'Design'],
  skills: { Hire: ['Excavator', 'Mason'], Design: ['Interior design'] },
  serviceIds: null,
  skillIds: null,
  pendingChanges: null,
  ...over,
});

describe('backfillSkills', () => {
  const catalog = seededCatalog();

  it('maps the live name columns to ids', () => {
    expect(backfillSkills(catalog, profile())).toEqual({
      serviceIds: ['svc:Hire', 'svc:Design'],
      skillIds: {
        'svc:Hire': [EXCAVATOR, MASON],
        'svc:Design': ['svc:Design/Interior design'],
      },
      pendingChanges: null,
      unmatched: [],
    });
  });

  it('writes ids into pendingChanges that hold only names, keeping the rest', () => {
    const result = backfillSkills(
      catalog,
      profile({
        pendingChanges: {
          trade: 'Builder',
          services: ['Hire'],
          skills: { Hire: ['Excavator'] },
          submittedAt: 'earlier',
        },
      }),
    );
    expect(result?.pendingChanges).toEqual({
      trade: 'Builder',
      services: ['Hire'],
      skills: { Hire: ['Excavator'] },
      submittedAt: 'earlier',
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [EXCAVATOR] },
    });
  });

  it('leaves pendingChanges that already carry ids, or are not name-shaped, alone', () => {
    const withIds = {
      services: ['Hire'],
      skills: { Hire: [] },
      serviceIds: ['svc:Hire'],
      skillIds: { 'svc:Hire': [] },
    };
    expect(
      backfillSkills(catalog, profile({ pendingChanges: withIds }))
        ?.pendingChanges,
    ).toBeNull();
    expect(
      backfillSkills(catalog, profile({ pendingChanges: { trade: 'x' } }))
        ?.pendingChanges,
    ).toBeNull();
  });

  it('reports unmatched names from both the live columns and pendingChanges, and still maps the rest', () => {
    const result = backfillSkills(
      catalog,
      profile({
        services: ['Hire', 'Gardening'],
        skills: { Hire: ['Excavator', 'Wizard'] },
        pendingChanges: {
          services: ['Design'],
          skills: { Design: ['Moon plan'] },
        },
      }),
    );
    expect(result?.serviceIds).toEqual(['svc:Hire']);
    expect(result?.skillIds).toEqual({ 'svc:Hire': [EXCAVATOR] });
    expect(result?.unmatched).toEqual([
      'Hire › Wizard',
      'Gardening',
      'Design › Moon plan',
    ]);
    expect(result?.pendingChanges).toMatchObject({
      serviceIds: ['svc:Design'],
      skillIds: { 'svc:Design': [] },
    });
  });

  it('does nothing for a profile that already has ids, so a second run changes nothing', () => {
    const first = backfillSkills(catalog, profile());
    expect(first).not.toBeNull();
    const second = backfillSkills(
      catalog,
      profile({ serviceIds: first!.serviceIds, skillIds: first!.skillIds }),
    );
    expect(second).toBeNull();
  });

  it('treats a profile with only one of the two columns as not yet backfilled', () => {
    expect(
      backfillSkills(catalog, profile({ serviceIds: ['svc:Hire'] })),
    ).not.toBeNull();
  });

  it('tolerates legacy empty-array skills', () => {
    expect(
      backfillSkills(catalog, profile({ services: ['Design'], skills: [] })),
    ).toMatchObject({
      serviceIds: ['svc:Design'],
      skillIds: { 'svc:Design': [] },
    });
  });
});
