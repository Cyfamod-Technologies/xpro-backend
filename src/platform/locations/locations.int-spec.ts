import { PrismaClient } from '@prisma/client';
import { LocationsService } from './locations.service';
import {
  AMAC_ID,
  FCT_ID,
  KUBWA_ID,
  LAGOS_ID,
  LIFE_CAMP_ID,
} from './locations.testkit';

const prisma = new PrismaClient();
const service = new LocationsService(prisma as never, {} as never, {} as never);
const OTHER_NOT_LISTED = '00000000-0000-4000-8000-000000000016';

describe('locations (integration, as the migration leaves them)', () => {
  afterAll(() => prisma.$disconnect());

  it('seeds every state, with the old Abuja city kept as FCT', async () => {
    expect(await prisma.location.count({ where: { kind: 'state' } })).toBe(37);
    await expect(
      prisma.location.findUniqueOrThrow({ where: { id: FCT_ID } }),
    ).resolves.toMatchObject({
      name: 'FCT',
      kind: 'state',
      aliases: ['Abuja (FCT)', 'Federal Capital Territory'],
      serviceable: true,
      ancestorIds: [],
    });
  });

  it('seeds the LGAs and gives every row the ancestors its kind implies', async () => {
    expect(
      await prisma.location.count({ where: { kind: 'lga' } }),
    ).toBeGreaterThanOrEqual(774);
    const rows = await prisma.location.findMany({
      select: { id: true, kind: true, parentId: true, ancestorIds: true },
    });
    const depth = { state: 0, lga: 1, area: 2 };
    for (const row of rows) {
      expect(row.ancestorIds).toHaveLength(depth[row.kind]);
      expect(row.ancestorIds.at(-1) ?? null).toBe(row.parentId);
    }
  });

  it('moves the old districts under their LGA as served areas', async () => {
    await expect(
      prisma.location.findUniqueOrThrow({ where: { id: LIFE_CAMP_ID } }),
    ).resolves.toMatchObject({
      kind: 'area',
      parentId: AMAC_ID,
      ancestorIds: [FCT_ID, AMAC_ID],
      serviceable: true,
    });
    const kubwa = await prisma.location.findUniqueOrThrow({
      where: { id: KUBWA_ID },
    });
    expect(kubwa.parentId).not.toBe(AMAC_ID);
    expect(kubwa.ancestorIds[0]).toBe(FCT_ID);
    await expect(
      prisma.location.findUniqueOrThrow({ where: { id: OTHER_NOT_LISTED } }),
    ).resolves.toMatchObject({ active: false, serviceable: false });
  });

  it('serves FCT, Abuja Municipal, Bwari and the Abuja areas, and nothing else', async () => {
    const served = await prisma.location.findMany({
      where: { serviceable: true, active: true },
      select: { kind: true },
    });
    expect(served.filter(({ kind }) => kind === 'state')).toHaveLength(1);
    expect(served.filter(({ kind }) => kind === 'lga')).toHaveLength(2);
    expect(served.filter(({ kind }) => kind === 'area')).toHaveLength(14);
  });

  it('lists only served places for the request form, with hasChildren under the same filter', async () => {
    const states = await service.list(undefined, { serviceable: true });
    expect(states.map(({ id }) => id)).toEqual([FCT_ID]);
    const lgas = await service.list(FCT_ID, { serviceable: true });
    expect(lgas.map(({ name, hasChildren }) => [name, hasChildren])).toEqual(
      expect.arrayContaining([
        ['Abuja Municipal', true],
        ['Bwari', true],
      ]) as unknown,
    );
    expect(lgas).toHaveLength(2);
    expect(await service.list(LAGOS_ID, { serviceable: true })).toEqual([]);
    expect((await service.list(undefined)).length).toBeGreaterThanOrEqual(37);
    const lagos = await service.list(LAGOS_ID);
    expect(lagos.length).toBeGreaterThan(10);
    expect(lagos.every(({ hasChildren }) => !hasChildren)).toBe(true);
  });

  it('works out which places are served and which provider coverage reaches one', async () => {
    const lagosLga = await prisma.location.findFirstOrThrow({
      where: { parentId: LAGOS_ID },
    });
    await expect(
      service.served([LIFE_CAMP_ID, AMAC_ID, FCT_ID, LAGOS_ID, lagosLga.id]),
    ).resolves.toEqual(new Set([LIFE_CAMP_ID, AMAC_ID, FCT_ID]));
    await expect(service.outsideServedAreas([LIFE_CAMP_ID])).resolves.toBe(
      false,
    );
    await expect(service.outsideServedAreas([FCT_ID])).resolves.toBe(false);
    await expect(service.outsideServedAreas([LAGOS_ID])).resolves.toBe(true);
    await expect(
      service.outsideServedAreas([lagosLga.id, LAGOS_ID]),
    ).resolves.toBe(true);
  });

  it('validates a provider home LGA and areas against the real table', async () => {
    await expect(
      service.validateProviderLocations({
        locationId: AMAC_ID,
        serviceAreaIds: [LIFE_CAMP_ID, LAGOS_ID, LIFE_CAMP_ID],
      }),
    ).resolves.toEqual({
      locationId: AMAC_ID,
      serviceAreaIds: [LIFE_CAMP_ID, LAGOS_ID],
    });
    await expect(
      service.validateProviderLocations({
        locationId: FCT_ID,
        serviceAreaIds: [LIFE_CAMP_ID],
      }),
    ).rejects.toThrow('Choose your state and LGA from the list.');
    await expect(
      service.validateProviderLocations({
        locationId: AMAC_ID,
        serviceAreaIds: [OTHER_NOT_LISTED],
      }),
    ).rejects.toThrow('Choose service areas from the location list.');
  });
});
