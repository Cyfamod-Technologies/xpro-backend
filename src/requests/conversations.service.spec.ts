import type { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import type { StaffPermission } from '../staff/staff-permissions';
import { ConversationsService } from './conversations.service';
import type { ConversationRow } from './conversations.query';
import { encodeCursor } from './conversations.query';
import { ConversationListQueryDto } from './dto/conversation-list-query.dto';
import { listProjection } from './projections/list.projection';

jest.mock('./projections/list.projection', () => ({
  listProjection: jest.fn(),
}));

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function staffWith(
  permissions: StaffPermission[],
  status: 'active' | 'suspended' = 'active',
): ActorContext {
  return {
    userId: STAFF_ID,
    kind: 'staff',
    displayName: 'Sam Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status,
      roles: [],
      permissions: new Set(permissions),
      canOwn: true,
      isSuperAdmin: false,
      permVersion: 1,
    },
  };
}

const customer: ActorContext = {
  userId: OWNER_ID,
  kind: 'customer',
  displayName: 'Casey',
  platformRoles: ['customer'],
  accountActive: true,
};

const ALL: StaffPermission[] = [
  'message.customer',
  'message.provider',
  'message.internal',
];

function row(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: REQUEST_ID,
    number: 42,
    status: 'in_progress',
    title: 'Roof replacement',
    staffOwnerId: OWNER_ID,
    customerName: 'Chika',
    providerId: 'profile-1',
    channel: 'customer',
    authorId: STAFF_ID,
    authorRole: 'staff',
    text: 'Checking now',
    lastMessageAt: new Date('2026-10-30T10:00:00.000Z'),
    waiting: 0,
    ...overrides,
  };
}

function setup(
  actor: ActorContext,
  rows: ConversationRow[] = [],
  counts: Array<{ status: string; count: number }> = [],
) {
  const queryRaw = jest.fn((statement: Prisma.Sql) =>
    Promise.resolve(
      statement.sql.includes('count(*)::int AS count') ? counts : rows,
    ),
  );
  const prisma = {
    $queryRaw: queryRaw,
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: OWNER_ID,
          firstName: 'Ada',
          lastName: 'Okafor',
          name: null,
          email: 'ada@example.com',
        },
        {
          id: STAFF_ID,
          firstName: 'Sam',
          lastName: 'Staff',
          name: null,
          email: 'sam@example.com',
        },
        {
          id: 'customer-user',
          firstName: null,
          lastName: null,
          name: null,
          email: 'chika@example.com',
        },
      ]),
    },
    providerProfile: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'profile-1',
          businessName: ' Tunde Roofing ',
          user: { firstName: 'Tunde', lastName: 'Bello' },
        },
        {
          id: 'profile-2',
          businessName: null,
          user: { firstName: 'Ngozi', lastName: 'Eze' },
        },
      ]),
    },
    serviceRequest: {
      findMany: jest.fn().mockResolvedValue([{ id: REQUEST_ID }]),
    },
  };
  const listLoader = {
    attachSnapshots: jest
      .fn()
      .mockResolvedValue([{ row: { id: REQUEST_ID }, snapshot: {} }]),
  };
  const settings = { snapshot: jest.fn().mockResolvedValue([]) };
  const service = new ConversationsService(
    prisma as never,
    { resolve: jest.fn().mockResolvedValue(actor) } as never,
    listLoader,
    settings as never,
  );
  const list = (query: Partial<ConversationListQueryDto> = {}) =>
    service.list(
      { id: STAFF_ID } as never,
      Object.assign(new ConversationListQueryDto(), query),
    );
  return { prisma, listLoader, queryRaw, service, list };
}

describe('ConversationsService.list', () => {
  beforeEach(() => {
    (listProjection as jest.Mock).mockReset();
    (listProjection as jest.Mock).mockReturnValue({
      statusLabel: 'In progress',
    });
  });

  it.each([
    ['no message permission', staffWith(['view.pricing'])],
    ['an inactive staff member', staffWith(ALL, 'suspended')],
    ['a customer', customer],
  ])('answers 403 FORBIDDEN for %s without querying', async (_name, actor) => {
    const { list, queryRaw } = setup(actor);
    await expect(list()).rejects.toMatchObject({
      constructor: AppError,
      code: 'FORBIDDEN',
    });
    await expect(list()).rejects.toMatchObject({
      message: expect.stringContaining('Choose a conversation') as string,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    [
      ALL,
      [
        "m.channel = 'customer'",
        "m.channel = 'provider'",
        "m.channel = 'internal'",
      ],
      [],
    ],
    [
      ['message.provider', 'message.internal'] as StaffPermission[],
      ["m.channel = 'provider'", "m.channel = 'internal'"],
      ["m.channel = 'customer'"],
    ],
    [
      ['message.customer'] as StaffPermission[],
      ["m.channel = 'customer'"],
      ["m.channel = 'provider'", "m.channel = 'internal'"],
    ],
  ])(
    'reads only the permitted channels (%j)',
    async (permissions, present, absent) => {
      const { list, queryRaw } = setup(staffWith(permissions));
      await list();
      const sql = queryRaw.mock.calls[0][0].sql;
      for (const fragment of present) expect(sql).toContain(fragment);
      for (const fragment of absent) expect(sql).not.toContain(fragment);
    },
  );

  it('shapes an item and never returns contact details', async () => {
    const { list } = setup(staffWith(ALL), [
      row({ waiting: 3, channel: 'internal', text: 'Call them back' }),
    ]);
    const result = await list();
    expect(result.data).toEqual([
      {
        requestId: 'XPR-00042',
        title: 'Roof replacement',
        status: 'in_progress',
        statusLabel: 'In progress',
        closed: false,
        owner: { id: OWNER_ID, name: 'Ada Okafor' },
        customer: { name: 'Chika' },
        provider: { name: 'Tunde Roofing' },
        lastMessage: {
          audience: 'internal',
          authorRole: 'staff',
          authorLabel: 'Sam Staff',
          text: 'Call them back',
          at: new Date('2026-10-30T10:00:00.000Z'),
        },
        waitingForXpro: 3,
      },
    ]);
  });

  it('flags closed, cancelled and rejected requests', async () => {
    const { list } = setup(staffWith(ALL), [
      row({ status: 'closed' }),
      row({ status: 'cancelled' }),
      row({ status: 'rejected' }),
      row({ status: 'blocked' }),
    ]);
    const result = await list();
    expect(result.data.map((item) => item.closed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('handles requests with no owner and no provider, and falls back for names', async () => {
    const { list } = setup(staffWith(ALL), [
      row({ staffOwnerId: null, providerId: null }),
      row({
        providerId: 'profile-2',
        authorRole: 'customer',
        authorId: 'customer-user',
      }),
      row({
        providerId: 'profile-missing',
        authorRole: 'provider',
        authorId: null,
      }),
      row({ authorRole: 'staff', authorId: null }),
      row({ authorRole: 'system', authorId: null }),
    ]);
    const { data } = await list();
    expect(data[0].owner).toBeNull();
    expect(data[0].provider).toBeNull();
    expect(data[1].provider).toEqual({ name: 'Ngozi Eze' });
    expect(data[1].lastMessage.authorLabel).toBe('chika@example.com');
    expect(data[2].provider).toEqual({ name: 'Provider' });
    expect(data[2].lastMessage.authorLabel).toBe('Provider');
    expect(data[3].lastMessage.authorLabel).toBe('XPro');
    expect(data[4].lastMessage.authorLabel).toBe('XPro system');
  });

  it('cuts the preview text', async () => {
    const { list } = setup(staffWith(ALL), [
      row({ text: `${'word '.repeat(60)}` }),
    ]);
    const { data } = await list();
    expect(data[0].lastMessage.text.endsWith('…')).toBe(true);
    expect(data[0].lastMessage.text.length).toBeLessThanOrEqual(141);
  });

  it('falls back to the status when the projection has no label', async () => {
    (listProjection as jest.Mock).mockReturnValue({ statusLabel: null });
    const { list } = setup(staffWith(ALL), [row()]);
    expect((await list()).data[0].statusLabel).toBe('in_progress');
  });

  it('batches name and label lookups instead of querying per row', async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row({ number: index + 1 }),
    );
    const { list, prisma, listLoader, queryRaw } = setup(staffWith(ALL), rows);
    await list();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.providerProfile.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.serviceRequest.findMany).toHaveBeenCalledTimes(1);
    expect(listLoader.attachSnapshots).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('skips lookups for an empty page', async () => {
    const { list, prisma } = setup(
      staffWith(ALL),
      [],
      [{ status: 'quoted', count: 2 }],
    );
    const result = await list({ status: ['in_progress'] });
    expect(result).toEqual({
      data: [],
      meta: { nextCursor: null, statusCounts: { quoted: 2 } },
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
  });

  it('lists status counts in lifecycle order and drops zero counts', async () => {
    const { list } = setup(
      staffWith(ALL),
      [row()],
      [
        { status: 'closed', count: 1 },
        { status: 'under_review', count: 4 },
        { status: 'in_progress', count: 3 },
        { status: 'quoted', count: 0 },
      ],
    );
    const { meta } = await list();
    expect(Object.entries(meta.statusCounts)).toEqual([
      ['under_review', 4],
      ['in_progress', 3],
      ['closed', 1],
    ]);
  });

  it('asks for one extra row and returns a cursor only when more remain', async () => {
    const rows = [
      row({ number: 9, lastMessageAt: new Date('2026-10-30T10:03:00.000Z') }),
      row({ number: 8, lastMessageAt: new Date('2026-10-30T10:02:00.000Z') }),
      row({ number: 7, lastMessageAt: new Date('2026-10-30T10:01:00.000Z') }),
    ];
    const paged = setup(staffWith(ALL), rows);
    const first = await paged.list({ limit: 2 });
    expect(first.data.map((item) => item.requestId)).toEqual([
      'XPR-00009',
      'XPR-00008',
    ]);
    expect(first.meta.nextCursor).toBe(
      encodeCursor({ at: new Date('2026-10-30T10:02:00.000Z'), number: 8 }),
    );
    expect(paged.queryRaw.mock.calls[0][0].values).toContain(3);

    const last = setup(staffWith(ALL), rows.slice(0, 2));
    expect((await last.list({ limit: 2 })).meta.nextCursor).toBeNull();
  });

  it('uses the default page size of 25', async () => {
    const { list, queryRaw } = setup(staffWith(ALL));
    await list();
    expect(queryRaw.mock.calls[0][0].values).toContain(26);
  });

  it('passes the cursor, status list and trimmed search to the SQL', async () => {
    const { list, queryRaw } = setup(staffWith(ALL));
    const cursor = encodeCursor({
      at: new Date('2026-10-30T10:02:00.000Z'),
      number: 8,
    });
    await list({ cursor, status: ['quoted', 'closed'], q: '  roof_1  ' });
    const [pageSql, countSql] = queryRaw.mock.calls.map(
      ([statement]) => statement,
    );
    expect(pageSql.values).toEqual(
      expect.arrayContaining([
        ['quoted', 'closed'],
        '%roof\\_1%',
        '2026-10-30T10:02:00.000Z',
        8,
      ]),
    );
    // Counts see the search but not the status filter or the cursor.
    expect(countSql.values).toContain('%roof\\_1%');
    expect(countSql.values).not.toContainEqual(['quoted', 'closed']);
    expect(countSql.values).not.toContain('2026-10-30T10:02:00.000Z');
  });

  it('treats a blank search as none', async () => {
    const { list, queryRaw } = setup(staffWith(ALL));
    await list({ q: '   ' });
    expect(queryRaw.mock.calls[0][0].sql).not.toContain('ILIKE');
  });

  it('rejects a bad cursor with 422 VALIDATION_ERROR before querying', async () => {
    const { list, queryRaw } = setup(staffWith(ALL));
    await expect(list({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      constructor: AppError,
      code: 'VALIDATION_ERROR',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
