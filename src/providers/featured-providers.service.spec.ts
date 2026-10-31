import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  catalogRows,
  seededCatalog,
} from '../platform/catalog/catalog.testkit';
import {
  FEATURED_PROVIDER_LIMIT,
  FeaturedProvidersService,
  buildFeaturedList,
  displayNameFor,
  truncateBio,
  type FeaturedCandidate,
} from './featured-providers.service';

const NOW = new Date('2026-10-29T10:00:00.000Z');
const LONG_BIO =
  'Experienced and careful professional with many happy clients.';

type ProfileOverrides = {
  verification?: string;
  userStatus?: string;
  reliabilityStatus?: string;
  bio?: string;
  trade?: string;
  city?: string;
  photo?: unknown;
  businessName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  experience?: number;
  services?: unknown;
  serviceIds?: unknown;
  skillIds?: unknown;
  serviceAreaIds?: string[];
  reviewedAt?: Date | null;
  createdAt?: Date;
};

function profile(id: string, o: ProfileOverrides = {}) {
  return {
    id,
    userId: `user-${id}`,
    trade: o.trade ?? 'Plumbing',
    location: o.city === '' ? null : { name: o.city ?? 'Lagos' },
    services: o.services ?? ['Design', 7, 'Hiring'],
    serviceIds: o.serviceIds ?? null,
    skills: {},
    skillIds: o.skillIds ?? null,
    serviceAreaIds: o.serviceAreaIds ?? [
      'area-ikeja',
      'area-gone',
      'area-yaba',
    ],
    businessName: o.businessName ?? null,
    bio: o.bio ?? LONG_BIO,
    photo: 'photo' in o ? o.photo : { id: `photo-${id}`, name: 'a.png' },
    experience: o.experience ?? 4.8,
    verification: o.verification ?? 'approved',
    reliabilityStatus: o.reliabilityStatus ?? 'normal',
    reviewedAt: o.reviewedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    createdAt: o.createdAt ?? new Date('2025-12-01T00:00:00.000Z'),
    user: {
      firstName: 'firstName' in o ? o.firstName : 'Ada',
      lastName: 'lastName' in o ? o.lastName : 'okafor',
      status: o.userStatus ?? 'active',
    },
  };
}

type Setup = {
  profiles?: ReturnType<typeof profile>[];
  rows?: Array<{
    providerId: string;
    mode: 'pinned' | 'hidden';
    position: number | null;
    updatedAt?: Date;
  }>;
  stats?: Record<string, { jobs: number; endedAt?: Date | null }>;
  noShows?: string[];
  signedViewUrl?: jest.Mock;
  permissionDenied?: boolean;
  aggregate?: { count: number; max: Date | null };
  existingIds?: string[];
};

function setup(options: Setup = {}) {
  const rows = (options.rows ?? []).map((row) => ({
    ...row,
    updatedAt: row.updatedAt ?? NOW,
  }));
  const profiles = options.profiles ?? [];
  const prisma = {
    catalogService: {
      findMany: jest.fn().mockResolvedValue(catalogRows(seededCatalog())),
    },
    location: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'area-ikeja', name: 'Ikeja' },
        { id: 'area-yaba', name: 'Yaba' },
      ]),
    },
    featuredProvider: {
      findMany: jest.fn().mockResolvedValue(rows),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: options.aggregate?.count ?? rows.length },
        _max: { updatedAt: options.aggregate?.max ?? null },
      }),
      deleteMany: jest.fn().mockReturnValue('deleteMany'),
      createMany: jest
        .fn()
        .mockImplementation((args: unknown) => ({ createMany: args })),
    },
    providerProfile: {
      findMany: jest
        .fn()
        .mockImplementation((args: { select?: { id?: boolean } }) =>
          Promise.resolve(
            // updateState's existence check selects only ids
            args.select && Object.keys(args.select).length === 1
              ? (options.existingIds ?? profiles.map((p) => p.id)).map(
                  (id) => ({ id }),
                )
              : profiles,
          ),
        ),
    },
    assignment: {
      groupBy: jest.fn().mockResolvedValue(
        Object.entries(options.stats ?? {}).map(([providerId, stat]) => ({
          providerId,
          _count: { _all: stat.jobs },
          _max: { endedAt: stat.endedAt ?? null },
        })),
      ),
    },
    noShow: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (options.noShows ?? []).map((providerId) => ({ providerId })),
        ),
    },
    providerUpload: {
      findMany: jest.fn().mockImplementation(() =>
        Promise.resolve(
          profiles.map((p) => ({
            id: `photo-${p.id}`,
            ownerId: p.userId,
            storageKey: `photos/${p.id}.png`,
          })),
        ),
      ),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const storage = {
    signedViewUrl:
      options.signedViewUrl ??
      jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`https://cdn.test/${key}?sig=1`),
        ),
  };
  const audit = { record: jest.fn() };
  const actors = {
    resolve: jest.fn().mockResolvedValue({
      userId: 'u1',
      kind: 'staff',
      displayName: 'Staff',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(
          options.permissionDenied ? [] : ['provider.review'],
        ),
        canOwn: false,
        isSuperAdmin: false,
        permVersion: 1,
      },
    }),
  };
  const service = new FeaturedProvidersService(
    prisma as never,
    storage as never,
    audit as never,
    actors as never,
  );
  return { service, prisma, storage, audit, actors };
}

function candidate(
  id: string,
  o: Partial<FeaturedCandidate> = {},
): FeaturedCandidate {
  return {
    id,
    trade: 'plumbing',
    completedJobs: 0,
    lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    ineligibleReasons: [],
    mode: null,
    position: null,
    ...o,
  };
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id);

describe('buildFeaturedList', () => {
  it.each([
    'not_approved',
    'inactive_account',
    'reliability_review',
    'recent_no_show',
    'incomplete_profile',
  ])('excludes a default candidate with %s', (reason) => {
    const list = buildFeaturedList([
      candidate('ok'),
      candidate('bad', { ineligibleReasons: [reason] }),
    ]);
    expect(ids(list)).toEqual(['ok']);
  });

  it('never shows a hidden provider, even when it would rank first', () => {
    const list = buildFeaturedList([
      candidate('top', { completedJobs: 99, mode: 'hidden' }),
      candidate('other', { completedJobs: 1 }),
    ]);
    expect(ids(list)).toEqual(['other']);
  });

  it('puts pinned first in position order and still shows pins with only reliability/incomplete reasons', () => {
    const list = buildFeaturedList([
      candidate('default', { completedJobs: 50 }),
      candidate('pin-b', {
        mode: 'pinned',
        position: 1,
        ineligibleReasons: ['reliability_review'],
      }),
      candidate('pin-a', {
        mode: 'pinned',
        position: 0,
        ineligibleReasons: ['incomplete_profile', 'recent_no_show'],
      }),
    ]);
    expect(list).toEqual([
      { id: 'pin-a', source: 'pinned' },
      { id: 'pin-b', source: 'pinned' },
      { id: 'default', source: 'default' },
    ]);
  });

  it('skips pinned providers that are not approved or inactive', () => {
    const list = buildFeaturedList([
      candidate('gone', {
        mode: 'pinned',
        position: 0,
        ineligibleReasons: ['not_approved'],
      }),
      candidate('inactive', {
        mode: 'pinned',
        position: 1,
        ineligibleReasons: ['inactive_account'],
      }),
      candidate('fine', { mode: 'pinned', position: 2 }),
    ]);
    expect(ids(list)).toEqual(['fine']);
  });

  it('ranks by completed jobs, then recency, then id', () => {
    const list = buildFeaturedList([
      candidate('c', {
        completedJobs: 3,
        lastActiveAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      candidate('b', {
        completedJobs: 5,
        lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      candidate('a', {
        completedJobs: 5,
        lastActiveAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
      candidate('d', {
        completedJobs: 3,
        lastActiveAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ]);
    expect(ids(list)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('spreads across trades round-robin, ordering groups by best member', () => {
    const list = buildFeaturedList([
      candidate('p1', { trade: 'Plumbing', completedJobs: 10 }),
      candidate('p2', { trade: ' plumbing ', completedJobs: 9 }),
      candidate('p3', { trade: 'PLUMBING', completedJobs: 8 }),
      candidate('e1', { trade: 'Electrical', completedJobs: 7 }),
      candidate('e2', { trade: 'Electrical', completedJobs: 6 }),
      candidate('c1', { trade: 'Cleaning', completedJobs: 1 }),
    ]);
    expect(ids(list)).toEqual(['p1', 'e1', 'c1', 'p2', 'e2', 'p3']);
  });

  it('counts visible pinned trades so the fill does not repeat a pinned trade first', () => {
    const list = buildFeaturedList([
      candidate('pin', { trade: 'Construction', mode: 'pinned', position: 0 }),
      candidate('design', { trade: 'Design', completedJobs: 9 }),
      candidate('construction', { trade: 'Construction', completedJobs: 7 }),
      candidate('hire', { trade: 'Hiring', completedJobs: 4 }),
    ]);
    expect(ids(list)).toEqual(['pin', 'design', 'hire', 'construction']);
  });

  it('caps at 12 with pinned providers counted against the cap', () => {
    const defaults = Array.from({ length: 20 }, (_, i) =>
      candidate(`d${String(i).padStart(2, '0')}`, { completedJobs: 20 - i }),
    );
    const pins = [0, 1, 2].map((i) =>
      candidate(`pin${i}`, { mode: 'pinned', position: i }),
    );
    const list = buildFeaturedList([...defaults, ...pins]);
    expect(list).toHaveLength(FEATURED_PROVIDER_LIMIT);
    expect(list.filter((item) => item.source === 'pinned')).toHaveLength(3);
    expect(list.filter((item) => item.source === 'default')).toHaveLength(9);
  });
});

describe('card helpers', () => {
  it('builds display names from business name or first name plus last initial', () => {
    const user = { firstName: 'Ada', lastName: 'okafor' };
    expect(displayNameFor({ businessName: '  Ada Fix Ltd ', user })).toBe(
      'Ada Fix Ltd',
    );
    expect(displayNameFor({ businessName: '   ', user })).toBe('Ada O.');
    expect(displayNameFor({ businessName: null, user })).toBe('Ada O.');
    expect(
      displayNameFor({
        businessName: null,
        user: { firstName: 'Ada', lastName: '' },
      }),
    ).toBe('Ada');
    expect(
      displayNameFor({
        businessName: null,
        user: { firstName: 'Ada', lastName: null },
      }),
    ).toBe('Ada');
  });

  it('truncates long bios at a word boundary with an ellipsis, within 220 chars', () => {
    const bio = Array.from({ length: 80 }, () => 'reliable').join('   ');
    const out = truncateBio(bio);
    expect(out.length).toBeLessThanOrEqual(220);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
    expect(
      out
        .slice(0, -1)
        .split(' ')
        .every((w) => w === 'reliable'),
    ).toBe(true);
  });

  it('collapses whitespace and leaves short bios untouched', () => {
    expect(truncateBio('  hello \n  world  ')).toBe('hello world');
  });
});

describe('FeaturedProvidersService.publicList', () => {
  it('returns cards with exactly the public keys and no contact/internal data', async () => {
    const { service } = setup({
      profiles: [profile('p1', { experience: 4.8 })],
      stats: { p1: { jobs: 6, endedAt: NOW } },
    });

    const { providers } = await service.publicList();

    expect(providers).toHaveLength(1);
    expect(Object.keys(providers[0]).sort()).toEqual(
      [
        'areas',
        'bio',
        'city',
        'completedJobs',
        'displayName',
        'experienceYears',
        'id',
        'photoUrl',
        'services',
        'trade',
      ].sort(),
    );
    expect(providers[0]).toEqual({
      id: 'p1',
      displayName: 'Ada O.',
      trade: 'Plumbing',
      services: ['Design', 'Hiring'],
      city: 'Lagos',
      areas: ['Ikeja', 'Yaba'],
      photoUrl: 'https://cdn.test/photos/p1.png?sig=1',
      bio: LONG_BIO,
      completedJobs: 6,
      experienceYears: 4,
    });
    const json = JSON.stringify(providers);
    for (const forbidden of [
      'phone',
      'email',
      'documents',
      'userId',
      'user-p1',
    ])
      expect(json).not.toContain(forbidden);
  });

  it('shows the current service names for stored ids, so a rename reaches the card', async () => {
    const { service } = setup({
      profiles: [
        profile('p1', {
          services: ['Old name'],
          serviceIds: ['svc:Design', 'svc:Hiring', 'deleted-id'],
          skillIds: { 'svc:Design': [], 'svc:Hiring': [] },
        }),
      ],
    });
    const { providers } = await service.publicList();
    expect(providers[0].services).toEqual(['Design', 'Hiring']);
  });

  it('queries completed assignments and a 90 day confirmed no-show window', async () => {
    const { service, prisma } = setup({ profiles: [profile('p1')] });
    await service.publicList();

    expect(prisma.assignment.groupBy).toHaveBeenCalledWith({
      by: ['providerId'],
      where: { status: 'completed', providerId: { in: ['p1'] } },
      _count: { _all: true },
      _max: { endedAt: true },
    });
    const where = (
      prisma.noShow.findMany.mock.calls[0] as [
        { where: { status: string; decidedAt: { gte: Date } } },
      ]
    )[0].where;
    expect(where.status).toBe('confirmed');
    const age = Date.now() - where.decidedAt.gte.getTime();
    expect(Math.abs(age - 90 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
  });

  it('excludes providers for each reason derived from real profile data', async () => {
    const { service } = setup({
      profiles: [
        profile('ok'),
        profile('inactive', { userStatus: 'suspended' }),
        profile('review', { reliabilityStatus: 'review_due' }),
        profile('noshow'),
        profile('nophoto', { photo: null }),
        profile('badphoto', { photo: { name: 'x' } }),
        profile('shortbio', { bio: 'Too short' }),
        profile('notrade', { trade: '  ' }),
        profile('nocity', { city: '' }),
      ],
      noShows: ['noshow'],
    });
    const { providers } = await service.publicList();
    expect(ids(providers)).toEqual(['ok']);
  });

  it('honours hidden rows and pinned order from the database', async () => {
    const { service } = setup({
      profiles: [profile('a'), profile('b'), profile('c')],
      stats: { a: { jobs: 9 }, b: { jobs: 5 }, c: { jobs: 1 } },
      rows: [
        { providerId: 'a', mode: 'hidden', position: null },
        { providerId: 'c', mode: 'pinned', position: 0 },
      ],
    });
    const { providers } = await service.publicList();
    expect(ids(providers)).toEqual(['c', 'b']);
  });

  it('returns photoUrl null when storage throws', async () => {
    const { service } = setup({
      profiles: [profile('p1')],
      signedViewUrl: jest
        .fn()
        .mockRejectedValue(new Error('Object storage is not configured.')),
    });
    const { providers } = await service.publicList();
    expect(providers[0].photoUrl).toBeNull();
  });

  it('returns photoUrl null when the upload belongs to another user', async () => {
    const { service, prisma } = setup({ profiles: [profile('p1')] });
    prisma.providerUpload.findMany.mockResolvedValue([
      { id: 'photo-p1', ownerId: 'someone-else', storageKey: 'k' },
    ]);
    const { providers } = await service.publicList();
    expect(providers[0].photoUrl).toBeNull();
  });
});

describe('FeaturedProvidersService.adminState', () => {
  it('requires provider.review', async () => {
    const { service, actors } = setup({ permissionDenied: true });
    await expect(service.adminState('u1')).rejects.toThrow();
    expect(actors.resolve).toHaveBeenCalledWith('u1');
  });

  it('returns revision, pinned/hidden rows, preview and name-sorted candidates', async () => {
    const updatedAt = new Date('2026-10-28T09:00:00.000Z');
    const { service } = setup({
      profiles: [
        profile('z', { firstName: 'Zed', lastName: 'Lee' }),
        profile('a', {
          firstName: 'Amy',
          lastName: 'Bell',
          businessName: 'AB Co',
        }),
        profile('gone', { verification: 'delisted' }),
      ],
      rows: [
        { providerId: 'gone', mode: 'pinned', position: 0, updatedAt },
        { providerId: 'z', mode: 'hidden', position: null, updatedAt: NOW },
      ],
    });

    const state = await service.adminState('u1');

    expect(state.revision).toBe(`2:${NOW.toISOString()}`);
    expect(state.limit).toBe(12);
    expect(state.pinned).toEqual([
      expect.objectContaining({
        providerId: 'gone',
        eligible: false,
        ineligibleReasons: ['not_approved'],
      }),
    ]);
    expect(state.hidden.map((row) => row.providerId)).toEqual(['z']);
    expect(state.preview.map((card) => [card.id, card.source])).toEqual([
      ['a', 'default'],
    ]);
    expect(state.candidates.map((row) => row.name)).toEqual([
      'Amy Bell',
      'Zed Lee',
    ]);
    expect(state.candidates[0]).toEqual({
      providerId: 'a',
      name: 'Amy Bell',
      businessName: 'AB Co',
      trade: 'Plumbing',
      city: 'Lagos',
      completedJobs: 0,
      eligible: true,
      ineligibleReasons: [],
    });
  });

  it('uses revision "0:0" when there are no rows', async () => {
    const { service } = setup({});
    expect((await service.adminState('u1')).revision).toBe('0:0');
  });
});

describe('FeaturedProvidersService.updateState', () => {
  const dto = (
    over: Partial<{
      revision: string;
      pinned: string[];
      hidden: string[];
    }> = {},
  ) => ({
    revision: '0:0',
    pinned: ['a', 'b'],
    hidden: ['c'],
    ...over,
  });
  const profiles = ['a', 'b', 'c'].map((id) => profile(id));

  it('checks provider.review before anything else', async () => {
    const { service, prisma } = setup({ permissionDenied: true, profiles });
    await expect(service.updateState('u1', dto())).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a stale revision with ConflictException', async () => {
    const { service, prisma } = setup({ profiles });
    await expect(
      service.updateState(
        'u1',
        dto({ revision: '5:2026-01-01T00:00:00.000Z' }),
      ),
    ).rejects.toThrow(
      new ConflictException(
        'The featured list changed since you loaded it. Reload and try again.',
      ),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a provider that is both pinned and hidden', async () => {
    const { service } = setup({ profiles });
    await expect(
      service.updateState('u1', dto({ pinned: ['a'], hidden: ['a'] })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown provider ids', async () => {
    const { service, prisma } = setup({ profiles, existingIds: ['a', 'b'] });
    await expect(service.updateState('u1', dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replaces all rows in one transaction with positions, audits, and returns fresh state', async () => {
    const { service, prisma, audit } = setup({ profiles });

    const state = await service.updateState('u1', dto());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.featuredProvider.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.featuredProvider.createMany).toHaveBeenNthCalledWith(1, {
      data: [
        { providerId: 'a', mode: 'pinned', position: 0, updatedBy: 'u1' },
        { providerId: 'b', mode: 'pinned', position: 1, updatedBy: 'u1' },
      ],
    });
    expect(prisma.featuredProvider.createMany).toHaveBeenNthCalledWith(2, {
      data: [
        { providerId: 'c', mode: 'hidden', position: null, updatedBy: 'u1' },
      ],
    });
    const ops = (prisma.$transaction.mock.calls[0] as [unknown[]])[0];
    expect(ops).toHaveLength(3);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'u1',
        action: 'provider.featured.update',
        metadata: { pinned: ['a', 'b'], hidden: ['c'] },
      }),
    );
    expect(state.limit).toBe(12);
  });

  it('accepts clearing everything', async () => {
    const { service, prisma } = setup({ profiles });
    await service.updateState('u1', dto({ pinned: [], hidden: [] }));
    expect(prisma.featuredProvider.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(['deleteMany']);
  });
});
