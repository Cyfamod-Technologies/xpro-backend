import { rewriteProfile, type ProviderIdPlan } from './provider-ids';

const plan: ProviderIdPlan = {
  rootId: 'construction',
  groups: new Map([
    ['floor', ['tiling', 'paving']],
    ['wall', ['plaster', 'tiling']],
  ]),
  removedIds: new Set(['renovation', 'procurement', 'cement']),
  removedNames: new Set(['Procurement']),
};

const profile = (over: Record<string, unknown> = {}) => ({
  services: ['Construction', 'Procurement'],
  skills: { Construction: ['Floor finishing'], Procurement: ['Cement'] },
  serviceIds: ['construction', 'procurement'],
  skillIds: {
    construction: ['floor', 'wall', 'renovation', 'other'],
    procurement: ['cement'],
  },
  pendingChanges: null as unknown,
  ...over,
});

describe('rewriteProfile', () => {
  it('replaces a group with its leaves once, drops deleted ids and the deleted root', () => {
    expect(rewriteProfile(profile(), plan)).toEqual({
      services: ['Construction'],
      skills: { Construction: ['Floor finishing'] },
      serviceIds: ['construction'],
      skillIds: { construction: ['tiling', 'paving', 'plaster', 'other'] },
    });
  });

  it('only expands groups under the configured root', () => {
    expect(
      rewriteProfile(
        profile({
          serviceIds: ['design'],
          skillIds: { design: ['floor'] },
          services: ['Design'],
          skills: {},
        }),
        plan,
      ),
    ).toBeNull();
  });

  it('rewrites the ids and names held in pending changes and leaves its other keys', () => {
    const result = rewriteProfile(
      profile({
        serviceIds: ['construction'],
        skillIds: { construction: ['tiling'] },
        services: ['Construction'],
        skills: {},
        pendingChanges: {
          bio: 'x',
          services: ['Procurement', 'Construction'],
          serviceIds: ['procurement', 'construction'],
          skillIds: { construction: ['wall'], procurement: ['cement'] },
        },
      }),
      plan,
    );
    expect(result).toEqual({
      pendingChanges: {
        bio: 'x',
        services: ['Construction'],
        serviceIds: ['construction'],
        skillIds: { construction: ['plaster', 'tiling'] },
      },
    });
  });

  it('leaves absent ids alone and returns null when nothing changes', () => {
    expect(
      rewriteProfile(
        profile({
          serviceIds: null,
          skillIds: null,
          services: ['Design'],
          skills: {},
        }),
        plan,
      ),
    ).toBeNull();
  });

  it('is stable on a second pass', () => {
    const first = rewriteProfile(profile(), plan)!;
    expect(
      rewriteProfile(profile(first as Record<string, unknown>), plan),
    ).toBeNull();
  });
});
