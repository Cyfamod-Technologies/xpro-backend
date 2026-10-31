import { Prisma, PrismaClient } from '@prisma/client';
import { createUser, deleteTestUsers } from '../../test/integration/users';
import { formatGroupRef } from './domain/request-group';
import { LIFE_CAMP_ID } from '../platform/locations/locations.testkit';

const prisma = new PrismaClient();

const nextRef = async (tx: Prisma.TransactionClient) => {
  const [{ nextval }] = await tx.$queryRaw<Array<{ nextval: bigint }>>(
    Prisma.sql`SELECT nextval('request_group_ref_seq') AS nextval`,
  );
  return formatGroupRef(nextval);
};

describe('request groups (integration)', () => {
  let ownerId: string;

  const child = (title: string, extra: Record<string, unknown> = {}) => ({
    ownerId,
    customerName: 'Integration customer',
    title,
    service: 'Construction',
    locationId: LIFE_CAMP_ID,
    address: '1 Test Street',
    phone: '+2348012345678',
    description: 'Integration test request for a request group.',
    ...extra,
  });

  beforeAll(async () => {
    ownerId = (await createUser(prisma)).id;
  });

  afterEach(async () => {
    await prisma.serviceRequest.deleteMany({ where: { ownerId } });
    await prisma.requestGroup.deleteMany({ where: { ownerId } });
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  it('creates a group and its requests with a position each, in one transaction', async () => {
    const created = await prisma.$transaction(async (tx) => {
      const group = await tx.requestGroup.create({
        data: { ownerId, title: 'Office fit-out', ref: await nextRef(tx) },
      });
      const first = await tx.serviceRequest.create({
        data: child('Office fit-out — Roof', {
          groupId: group.id,
          groupPosition: 0,
        }),
      });
      const second = await tx.serviceRequest.create({
        data: child('Office fit-out — Plumbing', {
          groupId: group.id,
          groupPosition: 1,
        }),
      });
      return { group, first, second };
    });

    const rows = await prisma.serviceRequest.findMany({
      where: { groupId: created.group.id },
      orderBy: { groupPosition: 'asc' },
    });
    expect(rows.map(({ id }) => id)).toEqual([
      created.first.id,
      created.second.id,
    ]);
    expect(rows.map(({ groupPosition }) => groupPosition)).toEqual([0, 1]);
    expect(created.group.ref).toMatch(/^XPG-\d{5,}$/);
  });

  it('leaves group_id and group_position empty for a request created on its own', async () => {
    const request = await prisma.serviceRequest.create({
      data: child('Single service'),
    });
    expect(request.groupId).toBeNull();
    expect(request.groupPosition).toBeNull();
  });

  it('hands out increasing, unique XPG references from its own sequence', async () => {
    const refs: string[] = [];
    for (let index = 0; index < 3; index++) {
      const group = await prisma.$transaction(async (tx) =>
        tx.requestGroup.create({
          data: { ownerId, title: `Project ${index}`, ref: await nextRef(tx) },
        }),
      );
      refs.push(group.ref);
    }
    const numbers = refs.map((ref) => Number(ref.slice(4)));
    expect(new Set(refs).size).toBe(3);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    await expect(
      prisma.requestGroup.create({
        data: { ownerId, title: 'Same reference', ref: refs[0] },
      }),
    ).rejects.toThrow();
  });

  it('rolls back the group and every request when a later request fails, and skips the used reference', async () => {
    let skipped = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const group = await tx.requestGroup.create({
          data: { ownerId, title: 'Rolled back', ref: await nextRef(tx) },
        });
        skipped = group.ref;
        await tx.serviceRequest.create({
          data: child('Rolled back — first', {
            groupId: group.id,
            groupPosition: 0,
          }),
        });
        // A required column left empty makes the second request fail.
        await tx.serviceRequest.create({
          data: child('Rolled back — second', {
            groupId: group.id,
            groupPosition: 1,
            address: null,
          }) as never,
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.requestGroup.count({ where: { ownerId } })).toBe(0);
    expect(await prisma.serviceRequest.count({ where: { ownerId } })).toBe(0);

    const next = await prisma.$transaction(async (tx) => nextRef(tx));
    expect(Number(next.slice(4))).toBeGreaterThan(Number(skipped.slice(4)));
  });

  it('refuses to delete a group that still has requests', async () => {
    const group = await prisma.requestGroup.create({
      data: {
        ownerId,
        title: 'Kept while it has children',
        ref: await prisma.$transaction((tx) => nextRef(tx)),
      },
    });
    await prisma.serviceRequest.create({
      data: child('Kept — first', { groupId: group.id, groupPosition: 0 }),
    });

    await expect(
      prisma.requestGroup.delete({ where: { id: group.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
