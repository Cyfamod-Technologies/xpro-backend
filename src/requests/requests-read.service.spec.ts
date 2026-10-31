import { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { RequestListQueryDto } from './dto/request-list-query.dto';
import { RequestsReadService } from './requests-read.service';

jest.mock('./projections/staff.projection', () => ({
  staffProjection: jest.fn((context: unknown) => ({ context })),
}));
jest.mock('./projections/customer.projection', () => ({
  customerProjection: jest.fn((context: unknown) => ({ context })),
}));
jest.mock('./projections/provider.projection', () => ({
  providerProjection: jest.fn((context: unknown) => ({ context })),
}));

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';

const staff: ActorContext = {
  userId: STAFF_ID,
  kind: 'staff',
  displayName: 'Staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    roles: [],
    permissions: new Set(['view.pricing']),
    canOwn: true,
    isSuperAdmin: false,
    permVersion: 1,
  },
};

function setup(
  actor: ActorContext = staff,
  settingRows: Array<{ key: string; value: unknown }> = [],
) {
  const prisma = {
    serviceRequest: {
      findMany: jest.fn((_args: unknown) => Promise.resolve([] as unknown[])),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: REQUEST_ID }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ openRequestLimit: null }),
    },
    requestGroup: {
      findUnique: jest.fn((args: { where: { id?: string; ref?: string } }) =>
        Promise.resolve(
          args.where.ref === 'XPG-00007' || args.where.id === GROUP_ID
            ? {
                id: GROUP_ID,
                ref: 'XPG-00007',
                title: 'Bathroom',
                ownerId: 'c',
              }
            : null,
        ),
      ),
    },
    $transaction: jest.fn((queries: Array<Promise<unknown>>) =>
      Promise.all(queries),
    ),
    $queryRaw: jest.fn((query: Prisma.Sql) =>
      Promise.resolve(query.sql.includes('count(*)') ? [{ total: 2 }] : []),
    ),
  };
  const listLoader = {
    attachSnapshots: jest.fn().mockResolvedValue([]),
  };
  const service = new RequestsReadService(
    prisma as never,
    { resolve: jest.fn().mockResolvedValue(actor) } as never,
    {} as never,
    listLoader,
    { snapshot: jest.fn().mockResolvedValue(settingRows) } as never,
  );
  const list = (query: Partial<RequestListQueryDto>) =>
    service.list(
      { id: STAFF_ID } as never,
      Object.assign(new RequestListQueryDto(), query),
    );
  const whereAnd = () =>
    (
      prisma.serviceRequest.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      }
    ).where.AND;
  return { prisma, listLoader, service, list, whereAnd };
}

describe('RequestsReadService.list', () => {
  it('filters staffOwnerId for owner=mine, unclaimed and a staff id', async () => {
    for (const [owner, expected] of [
      ['mine', { staffOwnerId: STAFF_ID }],
      ['unclaimed', { staffOwnerId: null }],
      [REQUEST_ID, { staffOwnerId: REQUEST_ID }],
    ] as const) {
      const { list, whereAnd } = setup();
      await list({ owner });
      expect(whereAnd()).toEqual([expected]);
    }
  });

  it('adds no owner condition for owner=all', async () => {
    const { list, whereAnd } = setup();
    await list({ owner: 'all' });
    expect(whereAnd()).toEqual([]);
  });

  it('rejects an owner that is not a keyword or a uuid with 422', async () => {
    const { list, prisma } = setup();
    await expect(list({ owner: 'nobody' })).rejects.toMatchObject({
      constructor: AppError,
      code: 'VALIDATION_ERROR',
    });
    expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
  });

  it('ignores the owner filter for a customer', async () => {
    const { list, whereAnd } = setup({
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    });
    await list({ owner: 'unclaimed' });
    expect(whereAnd()).toEqual([{ ownerId: STAFF_ID }]);
  });

  it('applies the sort with an id tiebreak and pages in SQL when nothing is derived', async () => {
    const { list, prisma } = setup();
    await list({ sort: 'createdAt:asc', page: 3, itemsPerPage: 10 });
    expect(prisma.serviceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: 20,
        take: 10,
      }),
    );
    expect(prisma.serviceRequest.count).toHaveBeenCalledTimes(1);
  });

  it('pushes status, service and q into SQL', async () => {
    const { list, whereAnd } = setup();
    await list({ status: 'matched', service: 'Hiring', q: 'XPR-00042' });
    expect(whereAnd()).toEqual([
      { status: 'matched' },
      { service: 'Hiring' },
      {
        OR: [
          { title: { contains: 'XPR-00042', mode: 'insensitive' } },
          { number: 42 },
        ],
      },
    ]);
  });

  it('narrows a stage filter to its status in SQL and scans one capped window', async () => {
    const { list, prisma, whereAnd } = setup();
    await list({ stage: 'quote_approval' });
    expect(whereAnd()).toContainEqual({ status: 'matched' });
    expect(prisma.serviceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(
      prisma.serviceRequest.findMany.mock.calls[0]?.[0],
    ).not.toHaveProperty('skip');
    expect(prisma.serviceRequest.count).not.toHaveBeenCalled();
  });

  it('excludes terminal statuses in SQL for nextActor=me', async () => {
    const { list, whereAnd } = setup();
    await list({ nextActor: 'me' });
    expect(whereAnd()).toContainEqual({
      status: { notIn: ['closed', 'cancelled', 'rejected'] },
    });
  });

  it('narrows the role-scoped list to a group by ref or id', async () => {
    for (const group of ['XPG-00007', GROUP_ID]) {
      const { list, whereAnd, prisma } = setup();
      await list({ group });
      expect(whereAnd()).toEqual([{ groupId: GROUP_ID }]);
      expect(prisma.serviceRequest.count).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a customer inside their own requests when filtering by group', async () => {
    const { list, whereAnd } = setup({
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    });
    await list({ group: 'XPG-00007' });
    expect(whereAnd()).toEqual([{ ownerId: STAFF_ID }, { groupId: GROUP_ID }]);
  });

  it('returns an empty page, not an error, for an unknown or malformed group', async () => {
    for (const group of ['XPG-00099', 'nonsense']) {
      const { list, prisma } = setup();
      const page = await list({ group, page: 2, itemsPerPage: 10 });
      expect(page).toMatchObject({ items: [], total: 0, page: 2, limit: 10 });
      expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
    }
  });

  it('ignores the group filter for a provider', async () => {
    const { list, whereAnd, prisma } = setup({
      userId: 'provider-1',
      kind: 'provider',
      displayName: 'Provider',
      platformRoles: ['provider'],
      accountActive: true,
    });
    await list({ group: 'XPG-00007' });
    expect(prisma.requestGroup.findUnique).not.toHaveBeenCalled();
    expect(JSON.stringify(whereAnd())).not.toContain(GROUP_ID);
    expect(whereAnd()).toHaveLength(1);
  });

  it('loads summaries through the light loader, never the full aggregate', async () => {
    const { list, listLoader, prisma } = setup();
    prisma.serviceRequest.findMany.mockResolvedValue([{ id: 'x' }]);
    await list({});
    expect(listLoader.attachSnapshots).toHaveBeenCalledWith(prisma, [
      { id: 'x' },
    ]);
  });
});

describe('RequestsReadService.activity', () => {
  it('queries audit rows by metadata requestId, newest first, with a total', async () => {
    const { service, prisma } = setup();
    const page = await service.activity(
      { id: STAFF_ID } as never,
      'XPR-00042',
      {
        page: 2,
      },
    );
    const [rows, count] = prisma.$queryRaw.mock.calls.map(([query]) => query);
    expect(rows.sql).toContain("metadata->>'requestId' = ?");
    expect(rows.sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(rows.values).toEqual([REQUEST_ID, 20, 20]);
    expect(count.values).toEqual([REQUEST_ID]);
    expect(page.total).toBe(2);
  });

  it('is staff only', async () => {
    const { service, prisma } = setup({
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    });
    await expect(
      service.activity({ id: 'customer-1' } as never, REQUEST_ID, { page: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown request', async () => {
    const { service, prisma } = setup();
    prisma.serviceRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.activity({ id: STAFF_ID } as never, REQUEST_ID, { page: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('RequestsReadService.pending', () => {
  it('reports no pending request and the full allowance when the account owns no open one', async () => {
    const { service } = setup();
    const result = await service.pending({ id: STAFF_ID } as never);
    expect(result).toEqual({
      hasPending: false,
      openCount: 0,
      limit: 3,
      remaining: 3,
    });
    expect(result).not.toHaveProperty('requestId');
  });

  it('returns the display id of the latest open request with the count and what remains', async () => {
    const { service, prisma } = setup(staff, [
      { key: 'request.maxOpenPerCustomer', value: 5 },
    ]);
    prisma.serviceRequest.findFirst.mockResolvedValue({ number: 42 });
    prisma.serviceRequest.count.mockResolvedValue(2);
    await expect(service.pending({ id: STAFF_ID } as never)).resolves.toEqual({
      hasPending: true,
      requestId: 'XPR-00042',
      openCount: 2,
      limit: 5,
      remaining: 3,
    });
  });

  it("uses the customer's override instead of the setting and floors remaining at 0", async () => {
    const { service, prisma } = setup(staff, [
      { key: 'request.maxOpenPerCustomer', value: 5 },
    ]);
    prisma.user.findUnique.mockResolvedValue({ openRequestLimit: 1 });
    prisma.serviceRequest.findFirst.mockResolvedValue({ number: 7 });
    prisma.serviceRequest.count.mockResolvedValue(2);
    await expect(service.pending({ id: STAFF_ID } as never)).resolves.toEqual({
      hasPending: true,
      requestId: 'XPR-00007',
      openCount: 2,
      limit: 1,
      remaining: 0,
    });
  });

  it('counts the owner’s non-terminal requests only', async () => {
    const { service, prisma } = setup();
    await service.pending({ id: STAFF_ID } as never);
    const [args] = prisma.serviceRequest.count.mock.calls[0] as [
      { where: { ownerId: string; status: { notIn: string[] } } },
    ];
    expect(args.where.ownerId).toBe(STAFF_ID);
    expect([...args.where.status.notIn].sort()).toEqual([
      'cancelled',
      'closed',
      'rejected',
    ]);
  });

  it('looks only at the owner’s non-terminal requests, newest first', async () => {
    const { service, prisma } = setup();
    await service.pending({ id: STAFF_ID } as never);
    const [args] = prisma.serviceRequest.findFirst.mock.calls[0] as [
      {
        where: { ownerId: string; status: { notIn: string[] } };
        orderBy: unknown;
        select: unknown;
      },
    ];
    expect(args.where.ownerId).toBe(STAFF_ID);
    expect([...args.where.status.notIn].sort()).toEqual([
      'cancelled',
      'closed',
      'rejected',
    ]);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.select).toEqual({ number: true });
  });
});

describe('RequestsReadService.detail customerRequestLimit', () => {
  const OWNER_ID = '33333333-3333-4333-8333-333333333333';
  const loaded = {
    row: { ownerId: OWNER_ID },
    snapshot: { ownerId: OWNER_ID },
  };
  const build = (actor: ActorContext) => {
    const { prisma } = setup(actor, [
      { key: 'request.maxOpenPerCustomer', value: 4 },
    ]);
    prisma.serviceRequest.count.mockResolvedValue(2);
    prisma.user.findUnique.mockResolvedValue({ openRequestLimit: 6 });
    return {
      prisma,
      service: new RequestsReadService(
        prisma as never,
        { resolve: jest.fn().mockResolvedValue(actor) } as never,
        { load: jest.fn().mockResolvedValue(loaded) },
        {} as never,
        {
          snapshot: jest
            .fn()
            .mockResolvedValue([
              { key: 'request.maxOpenPerCustomer', value: 4 },
            ]),
        } as never,
      ),
    };
  };
  const contextOf = (result: unknown) =>
    (result as { context: Record<string, unknown> }).context;

  it("gives staff the owner's override, effective limit and open count", async () => {
    const { service, prisma } = build(staff);
    const context = contextOf(
      await service.detail({ id: STAFF_ID } as never, 'XPR-00001'),
    );
    expect(context.customerRequestLimit).toEqual({
      userId: OWNER_ID,
      override: 6,
      effective: 6,
      open: 2,
    });
    const [countArgs] = prisma.serviceRequest.count.mock.calls[0] as [
      { where: { ownerId: string } },
    ];
    expect(countArgs.where.ownerId).toBe(OWNER_ID);
  });

  it('computes nothing for the owner or a provider', async () => {
    for (const kind of ['customer', 'provider'] as const) {
      const actor: ActorContext = {
        userId: OWNER_ID,
        kind,
        displayName: 'Person',
        platformRoles: [kind],
        accountActive: true,
      };
      const { service, prisma } = build(actor);
      const context = contextOf(
        await service.detail({ id: OWNER_ID } as never, 'XPR-00001'),
      );
      expect(context).not.toHaveProperty('customerRequestLimit');
      expect(prisma.serviceRequest.count).not.toHaveBeenCalled();
    }
  });
});

describe('RequestsReadService.detail group', () => {
  const OWNER_ID = '33333333-3333-4333-8333-333333333333';
  const PROVIDER_ID = '55555555-5555-4555-8555-555555555555';
  const loaded = {
    row: { id: REQUEST_ID, ownerId: OWNER_ID, groupId: GROUP_ID },
    snapshot: { ownerId: OWNER_ID, accessibleProviderUserIds: [PROVIDER_ID] },
  };
  const build = (actor: ActorContext) => {
    const { prisma } = setup(actor);
    const siblingRow = { id: 's1', number: 8, title: 'T', service: 'S' };
    prisma.requestGroup.findUnique.mockImplementation(() =>
      Promise.resolve({
        id: GROUP_ID,
        ref: 'XPG-00007',
        title: 'Bathroom',
        ownerId: OWNER_ID,
        requests: [siblingRow],
      }),
    );
    return {
      prisma,
      service: new RequestsReadService(
        prisma as never,
        { resolve: jest.fn().mockResolvedValue(actor) } as never,
        { load: jest.fn().mockResolvedValue(loaded) },
        { attachSnapshots: jest.fn().mockResolvedValue([]) },
        { snapshot: jest.fn().mockResolvedValue([]) } as never,
      ),
    };
  };
  const contextOf = (result: unknown) =>
    (result as { context: Record<string, unknown> }).context;

  it('hands staff and the owner the group view', async () => {
    const owner: ActorContext = {
      userId: OWNER_ID,
      kind: 'customer',
      displayName: 'Owner',
      platformRoles: ['customer'],
      accountActive: true,
    };
    for (const actor of [staff, owner]) {
      const { service } = build(actor);
      const context = contextOf(
        await service.detail({ id: actor.userId } as never, 'XPR-00001'),
      );
      expect(context.groupView).toEqual({
        group: { id: GROUP_ID, ref: 'XPG-00007', title: 'Bathroom' },
        siblings: [],
      });
    }
  });

  it('never loads or passes the group for a provider', async () => {
    const provider: ActorContext = {
      userId: PROVIDER_ID,
      kind: 'provider',
      displayName: 'Provider',
      platformRoles: ['provider'],
      accountActive: true,
    };
    const { service, prisma } = build(provider);
    const context = contextOf(
      await service.detail({ id: PROVIDER_ID } as never, 'XPR-00001'),
    );
    expect(context).not.toHaveProperty('groupView');
    expect(prisma.requestGroup.findUnique).not.toHaveBeenCalled();
  });
});
