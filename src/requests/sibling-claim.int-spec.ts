import { Prisma, PrismaClient } from '@prisma/client';
import {
  createStaff,
  createUser,
  deleteTestUsers,
} from '../../test/integration/users';
import { ApprovalsHooks } from './approvals.hooks';
import { formatGroupRef } from './domain/request-group';
import { resolveRequestGroup } from './request-group-ref';
import { LIST_ROW_SELECT } from './request-list.loader';
import { claimGroupSiblings } from './sibling-claim';

const prisma = new PrismaClient();
const hooks = new ApprovalsHooks({} as never);

const nextRef = async (tx: Prisma.TransactionClient) => {
  const [{ nextval }] = await tx.$queryRaw<Array<{ nextval: bigint }>>(
    Prisma.sql`SELECT nextval('request_group_ref_seq') AS nextval`,
  );
  return formatGroupRef(nextval);
};

describe('bundle claim and group list filter (integration)', () => {
  let ownerId: string;
  let staffId: string;
  let otherStaffId: string;

  const row = (title: string, extra: Record<string, unknown> = {}) => ({
    ownerId,
    customerName: 'Integration customer',
    title,
    service: 'Construction',
    cityId: 'city-int',
    districtId: 'district-int',
    address: '1 Test Street',
    phone: '+2348012345678',
    description: 'Integration test request for a bundle.',
    ...extra,
  });

  const makeGroup = (title: string) =>
    prisma.$transaction(async (tx) =>
      tx.requestGroup.create({
        data: { ownerId, title, ref: await nextRef(tx) },
      }),
    );

  /** What request.claim does to the claimed request, followed by the bundle step. */
  const claim = (
    request: { id: string; number: number; groupId: string },
    action: 'request.claimed' | 'request.auto_claimed' = 'request.claimed',
  ) =>
    prisma.$transaction(async (tx) => {
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: {
          staffOwnerId: staffId,
          claimedAt: new Date(),
          unclaimedSince: null,
          ownershipVersion: { increment: 1 },
        },
      });
      return claimGroupSiblings(tx, hooks, {
        groupId: request.groupId,
        trigger: request,
        staffId,
        actorType: 'staff',
        now: new Date(),
        action,
        command: 'request.claim',
      });
    });

  beforeAll(async () => {
    ownerId = (await createUser(prisma)).id;
    staffId = (await createStaff(prisma, ['operations'])).id;
    otherStaffId = (await createStaff(prisma, ['operations'])).id;
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['request.claimed', 'request.auto_claimed'] } },
    });
    await prisma.serviceRequest.deleteMany({ where: { ownerId } });
    await prisma.requestGroup.deleteMany({ where: { ownerId } });
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  it('claims both requests of a two-request bundle when staff claims one', async () => {
    const group = await makeGroup('Bathroom fit-out');
    const first = await prisma.serviceRequest.create({
      data: row('Bathroom fit-out — Tiling', {
        groupId: group.id,
        groupPosition: 0,
      }),
    });
    const second = await prisma.serviceRequest.create({
      data: row('Bathroom fit-out — Plumbing', {
        groupId: group.id,
        groupPosition: 1,
      }),
    });

    await expect(claim({ ...first, groupId: group.id })).resolves.toEqual([
      second.id,
    ]);

    const owned = await prisma.serviceRequest.findMany({
      where: { groupId: group.id },
      orderBy: { groupPosition: 'asc' },
    });
    expect(owned.map(({ staffOwnerId }) => staffOwnerId)).toEqual([
      staffId,
      staffId,
    ]);
    expect(owned[1].claimedAt).not.toBeNull();
    expect(owned[1].unclaimedSince).toBeNull();
    expect(owned[1].ownershipVersion).toBe(second.ownershipVersion + 1);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: second.id, action: 'request.claimed' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      note: `with XPR-${String(first.number).padStart(5, '0')} in the same project`,
    });
  });

  it('leaves an owned sibling and a closed sibling alone, and never touches another group', async () => {
    const group = await makeGroup('Garden and fence');
    const other = await makeGroup('Elsewhere');
    const trigger = await prisma.serviceRequest.create({
      data: row('Garden and fence — A', {
        groupId: group.id,
        groupPosition: 0,
      }),
    });
    const owned = await prisma.serviceRequest.create({
      data: row('Garden and fence — B', {
        groupId: group.id,
        groupPosition: 1,
        staffOwnerId: otherStaffId,
      }),
    });
    const closed = await prisma.serviceRequest.create({
      data: row('Garden and fence — C', {
        groupId: group.id,
        groupPosition: 2,
        status: 'closed',
      }),
    });
    const elsewhere = await prisma.serviceRequest.create({
      data: row('Elsewhere — A', { groupId: other.id, groupPosition: 0 }),
    });

    await expect(claim({ ...trigger, groupId: group.id })).resolves.toEqual([]);

    const after = await prisma.serviceRequest.findMany({
      where: { id: { in: [owned.id, closed.id, elsewhere.id] } },
      orderBy: { title: 'asc' },
    });
    expect(after.map(({ staffOwnerId }) => staffOwnerId)).toEqual([
      otherStaffId,
      null,
      null,
    ]);
    expect(
      await prisma.auditLog.count({ where: { action: 'request.claimed' } }),
    ).toBe(0);
  });

  it('filters the list by group ref or id, with the ref joined onto the row', async () => {
    const group = await makeGroup('Roof and gutters');
    await prisma.serviceRequest.create({
      data: row('Roof and gutters — A', {
        groupId: group.id,
        groupPosition: 0,
      }),
    });
    await prisma.serviceRequest.create({
      data: row('Roof and gutters — B', {
        groupId: group.id,
        groupPosition: 1,
      }),
    });
    await prisma.serviceRequest.create({ data: row('Single service') });

    for (const reference of [group.ref, group.id]) {
      const resolved = await resolveRequestGroup(prisma, reference);
      expect(resolved?.id).toBe(group.id);
      const rows = await prisma.serviceRequest.findMany({
        where: { AND: [{ ownerId }, { groupId: resolved!.id }] },
        select: LIST_ROW_SELECT,
        orderBy: { groupPosition: 'asc' },
      });
      expect(rows.map(({ groupPosition }) => groupPosition)).toEqual([0, 1]);
      expect(rows.every(({ group: joined }) => joined?.ref === group.ref)).toBe(
        true,
      );
    }
    await expect(
      resolveRequestGroup(prisma, formatGroupRef(999999)),
    ).resolves.toBeNull();
  });
});
