import type { ApprovalDeadline } from '@prisma/client';
import { ApprovalsService, approvalState } from './approvals.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const HOUR = 60 * 60_000;
const user = { id: 'me' } as never;

const row = (
  patch: Partial<ApprovalDeadline> & { kind: string; itemId: string },
): ApprovalDeadline => ({
  id: `row-${patch.itemId}`,
  requestId: 'r1',
  openedAt: new Date(NOW.getTime() - 5 * HOUR),
  startedAt: new Date(NOW.getTime() - 5 * HOUR),
  deadlineWorkingMinutes: 240,
  remindAt: new Date(NOW.getTime() + HOUR),
  dueAt: new Date(NOW.getTime() + 3 * HOUR),
  remindedAt: null,
  escalatedAt: null,
  closedAt: null,
  closedReason: null,
  openedBy: null,
  createdAt: NOW,
  ...patch,
});

function setup(
  rows: ApprovalDeadline[],
  options: {
    permissions?: string[];
    isSuperAdmin?: boolean;
    quotes?: Array<{ id: string; lastEditedBy: string }>;
    approvers?: string[];
  } = {},
) {
  const prisma = {
    approvalDeadline: {
      findMany: jest.fn().mockResolvedValue(rows),
      groupBy: jest.fn().mockResolvedValue([
        { kind: 'intake', _count: { _all: 2 } },
        { kind: 'refund', _count: { _all: 1 } },
      ]),
    },
    serviceRequest: {
      findMany: jest.fn(({ where }: { where: { id?: unknown } }) =>
        Promise.resolve(
          where.id
            ? [
                {
                  id: 'r1',
                  number: 42,
                  title: 'Roof repair',
                  ownerId: 'customer-1',
                  staffOwnerId: 'owner-1',
                  version: 7,
                },
              ]
            : [{ id: 'r1' }],
        ),
      ),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'owner-1',
          firstName: 'Ada',
          lastName: 'Eze',
          name: null,
          email: 'a@x',
        },
      ]),
    },
    quote: {
      findMany: jest.fn(({ where }: { where: { id?: unknown } }) =>
        Promise.resolve(where.id ? (options.quotes ?? []) : [{ id: 'q-mine' }]),
      ),
    },
    requestEscalation: {
      findMany: jest.fn().mockResolvedValue([{ id: 'e-mine' }]),
    },
    refund: { findMany: jest.fn().mockResolvedValue([{ id: 'f-mine' }]) },
    payment: { findMany: jest.fn().mockResolvedValue([{ id: 'p-mine' }]) },
    payout: { findMany: jest.fn().mockResolvedValue([]) },
    cancellation: { findMany: jest.fn().mockResolvedValue([]) },
    providerProfile: { findMany: jest.fn().mockResolvedValue([]) },
    providerBankAccount: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const actors = {
    resolve: jest.fn().mockResolvedValue({
      userId: 'me',
      kind: 'staff',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(options.permissions ?? ['request.review']),
        canOwn: true,
        isSuperAdmin: options.isSuperAdmin ?? false,
      },
    }),
  };
  const routing = {
    holderIds: jest.fn().mockResolvedValue(options.approvers ?? []),
  };
  const service = new ApprovalsService(
    prisma as never,
    actors as never,
    routing as never,
  );
  return { service, prisma, actors };
}

type Where = {
  closedAt: null;
  AND: Array<{ kind: { in: string[] }; OR: unknown[] }>;
};
const whereOf = (prisma: ReturnType<typeof setup>['prisma']): Where =>
  (prisma.approvalDeadline.findMany.mock.calls[0] as [{ where: Where }])[0]
    .where;

describe('ApprovalsService.list', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterAll(() => jest.useRealTimers());

  it('is open to any active staff member, not only request.review holders', async () => {
    const { service } = setup([], { permissions: ['refund.manage'] });
    await expect(service.list(user, {})).resolves.toMatchObject({ total: 0 });
  });

  it('refuses a caller who is not active staff', async () => {
    const { service, actors } = setup([]);
    actors.resolve.mockResolvedValue({ platformRoles: ['customer'] });
    await expect(service.list(user, {})).rejects.toMatchObject({ status: 403 });
  });

  it('defaults to can_act and narrows to the kinds the caller holds the permission for, in SQL', async () => {
    const { service, prisma } = setup([], {
      permissions: ['refund.manage', 'request.cancel.active'],
    });

    await service.list(user, {});

    const where = whereOf(prisma);
    expect(where.closedAt).toBeNull();
    const kinds = where.AND[0].kind.in;
    expect(kinds).toEqual(expect.arrayContaining(['refund', 'cancellation']));
    expect(kinds).not.toContain('payout');
    expect(kinds).not.toContain('intake');
  });

  it('all lists every open item and overdue narrows by due time', async () => {
    const all = setup([]);
    await all.service.list(user, { filter: 'all' });
    expect(whereOf(all.prisma)).toEqual({ closedAt: null });

    const overdue = setup([]);
    await overdue.service.list(user, { filter: 'overdue', kind: 'intake' });
    expect(whereOf(overdue.prisma).AND).toEqual([
      { kind: 'intake' },
      { dueAt: { lte: NOW } },
    ]);
  });

  it('mine matches the requests I own and the items I raised or opened', async () => {
    const { service, prisma } = setup([]);

    await service.list(user, { filter: 'mine' });

    expect(prisma.serviceRequest.findMany).toHaveBeenCalledWith({
      where: { staffOwnerId: 'me' },
      select: { id: true },
    });
    expect(whereOf(prisma).AND[0].OR).toEqual([
      { openedBy: 'me' },
      { requestId: { in: ['r1'] } },
      {
        itemId: {
          in: expect.arrayContaining([
            'e-mine',
            'f-mine',
            'p-mine',
            'q-mine',
          ]) as string[],
        },
      },
    ]);
  });

  it('rejects an unknown filter or kind', async () => {
    const { service } = setup([]);
    await expect(
      service.list(user, { filter: 'everything' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(service.list(user, { kind: 'made_up' })).rejects.toMatchObject(
      { status: 422 },
    );
  });

  it('returns the 02 §4.6 item shape', async () => {
    const { service } = setup([
      row({ kind: 'intake', itemId: 'r1', openedBy: 'u' }),
    ]);

    const { data } = await service.list(user, {});

    expect(data[0]).toEqual({
      id: 'row-r1',
      kind: 'intake',
      label: 'Intake review',
      itemId: 'r1',
      requestId: 'r1',
      requestCode: 'XPR-00042',
      providerId: null,
      title: 'Roof repair',
      ownerId: 'owner-1',
      ownerName: 'Ada Eze',
      decidingPermission: 'request.review',
      canDecide: true,
      blockedReason: null,
      createdAt: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
      dueAt: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
      remindAt: new Date(NOW.getTime() + HOUR).toISOString(),
      state: 'on_time',
      version: 7,
    });
  });

  it('cuts the page after canDecide, so the total counts only what the caller can act on', async () => {
    const rows = [
      row({ kind: 'quote_approval', itemId: 'q-edited' }),
      row({ kind: 'quote_approval', itemId: 'q-other' }),
      row({ kind: 'intake', itemId: 'r1' }),
    ];
    const { service } = setup(rows, {
      permissions: ['quote.approve', 'request.review'],
      quotes: [
        { id: 'q-edited', lastEditedBy: 'me' },
        { id: 'q-other', lastEditedBy: 'someone' },
      ],
      approvers: ['me', 'someone', 'third'],
    });

    const actable = await service.list(user, {});
    expect(actable.data.map((item) => item.itemId)).toEqual(['q-other', 'r1']);
    expect(actable.total).toBe(2);

    const everything = await service.list(user, { filter: 'all' });
    expect(everything.total).toBe(3);
    expect(everything.data[0]).toMatchObject({
      itemId: 'q-edited',
      canDecide: false,
      blockedReason: 'You edited this quote last.',
    });
  });

  it('pages 25 at a time', async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({ kind: 'intake', itemId: `i-${index}`, requestId: 'r1' }),
    );
    const { service } = setup(rows);

    const second = await service.list(user, { page: 2 });

    expect(second).toMatchObject({ page: 2, pageSize: 25, total: 30 });
    expect(second.data).toHaveLength(5);
  });

  it('marks an item due_soon past 50% and overdue past 100%', () => {
    const base = row({ kind: 'intake', itemId: 'x' });
    expect(
      approvalState({ ...base, remindAt: new Date(NOW.getTime() + 1) }, NOW),
    ).toBe('on_time');
    expect(approvalState({ ...base, remindAt: NOW }, NOW)).toBe('due_soon');
    expect(approvalState({ ...base, dueAt: NOW }, NOW)).toBe('overdue');
  });
});

describe('ApprovalsService.counts', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterAll(() => jest.useRealTimers());

  it('counts only the items the caller can decide, and overdue items per kind', async () => {
    const rows = [
      row({ kind: 'intake', itemId: 'r1' }),
      row({ kind: 'intake', itemId: 'r1b' }),
    ];
    const { service, prisma } = setup(rows);

    await expect(service.counts(user)).resolves.toEqual({
      canAct: 2,
      overdueByKind: { intake: 2, refund: 1 },
    });
    expect(prisma.approvalDeadline.groupBy).toHaveBeenCalledWith({
      by: ['kind'],
      where: { closedAt: null, dueAt: { lte: NOW } },
      _count: { _all: true },
    });
  });
});
