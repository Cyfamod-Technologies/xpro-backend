import { PrismaClient } from '@prisma/client';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { loadCatalog } from '../../platform/catalog/catalog.tree';
import { SEEDS } from '../registry';
import { runSeeds } from '../runner';
import { CATALOG_SERVICES, EXPANDED_GROUPS } from './catalog.data';
import { applyCatalog, catalogSeed } from './seed-catalog';

const prisma = new PrismaClient();
const quiet = () => undefined;

afterAll(async () => {
  await deleteTestUsers(prisma);
  await prisma.$disconnect();
});

const FLOOR = EXPANDED_GROUPS.groupIds[0];
const TILING = CATALOG_SERVICES[1].children![0].children![0];

describe('catalog seed (integration)', () => {
  it('has brought the migrated catalog to the seed tree and recorded it', async () => {
    const catalog = await loadCatalog(prisma);
    const expected = (nodes: typeof CATALOG_SERVICES): unknown[] =>
      nodes.map(({ id, name, children }) => ({
        id,
        name,
        children: expected(children ?? []),
      }));
    const actual = (nodes: typeof catalog.roots): unknown[] =>
      nodes
        .filter(({ active }) => active)
        .map(({ id, name, children }) => ({
          id,
          name,
          children: actual(children),
        }));
    expect(actual(catalog.roots)).toEqual(expected(CATALOG_SERVICES));
    const ledger = await prisma.dataSeed.findUniqueOrThrow({
      where: { name: 'catalog' },
    });
    expect(ledger.version).toBeGreaterThanOrEqual(catalogSeed.version);
  });

  it('skips a plain re-run and changes nothing when applied again', async () => {
    const [report] = await runSeeds(prisma, SEEDS, { only: 'catalog' }, quiet);
    expect(report.status).toBe('skipped');
    const summary = await prisma.$transaction((tx) => applyCatalog(tx));
    expect(Object.values(summary).every((count) => count === 0)).toBe(true);
  });

  it('re-applies with --force and finds nothing left to do', async () => {
    const [report] = await runSeeds(
      prisma,
      SEEDS,
      { only: 'catalog', force: true },
      quiet,
    );
    expect(report.status).toBe('applied');
    expect(Object.values(report.summary!).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('keeps an admin rename made after seeding on a plain re-run, and --force restores it', async () => {
    await prisma.catalogService.update({
      where: { id: TILING.id },
      data: { name: 'Floor tiles', version: { increment: 1 } },
    });
    await runSeeds(prisma, SEEDS, { only: 'catalog' }, quiet);
    expect(
      (
        await prisma.catalogService.findUniqueOrThrow({
          where: { id: TILING.id },
        })
      ).name,
    ).toBe('Floor tiles');

    await runSeeds(prisma, SEEDS, { only: 'catalog', force: true }, quiet);
    expect(
      (
        await prisma.catalogService.findUniqueOrThrow({
          where: { id: TILING.id },
        })
      ).name,
    ).toBe(TILING.name);
  });

  it('updates provider names and a Construction group held as a skill', async () => {
    const user = await createUser(prisma);
    const construction = CATALOG_SERVICES[1];
    const profile = await prisma.providerProfile.create({
      data: {
        userId: user.id,
        phone: '+2348000000001',
        trade: 'Fitter',
        services: ['Hire', 'Construction'],
        skills: { Hire: ['Mason'], Construction: ['Floor finishing'] },
        serviceIds: [construction.id],
        skillIds: { [construction.id]: [FLOOR] },
        pendingChanges: { services: ['Hire'], skills: { Hire: ['Mason'] } },
        workingHours: {},
        bio: 'Integration test provider.',
      },
    });
    await runSeeds(prisma, SEEDS, { only: 'catalog', force: true }, quiet);
    const after = await prisma.providerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(after.services).toEqual(['Hiring', 'Construction']);
    expect(after.skills).toEqual({
      Hiring: ['Mason'],
      Construction: ['Floor finishing'],
    });
    expect(after.pendingChanges).toEqual({
      services: ['Hiring'],
      skills: { Hiring: ['Mason'] },
    });
    expect(after.skillIds).toEqual({
      [construction.id]: CATALOG_SERVICES[1].children![0].children!.map(
        ({ id }) => id,
      ),
    });
  });
});
