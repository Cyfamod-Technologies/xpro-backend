import { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { RequestListQueryDto } from './dto/request-list-query.dto';
import { RequestsReadService } from './requests-read.service';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

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

function setup(actor: ActorContext = staff) {
  const prisma = {
    serviceRequest: {
      findMany: jest.fn((_args: unknown) => Promise.resolve([] as unknown[])),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: REQUEST_ID }),
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
    { snapshot: jest.fn().mockResolvedValue([]) } as never,
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
    await list({ status: 'matched', service: 'Hire', q: 'XPR-00042' });
    expect(whereAnd()).toEqual([
      { status: 'matched' },
      { service: 'Hire' },
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
  it('reports no pending request when the account owns no open one', async () => {
    const { service } = setup();
    const result = await service.pending({ id: STAFF_ID } as never);
    expect(result).toEqual({ hasPending: false });
    expect(result).not.toHaveProperty('requestId');
  });

  it('returns the display id of the open request', async () => {
    const { service, prisma } = setup();
    prisma.serviceRequest.findFirst.mockResolvedValue({ number: 42 });
    await expect(service.pending({ id: STAFF_ID } as never)).resolves.toEqual({
      hasPending: true,
      requestId: 'XPR-00042',
    });
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
