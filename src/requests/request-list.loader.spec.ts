import type { ActorContext } from '../platform/actor/actor.types';
import { listProjection } from './projections/list.projection';
import {
  LIST_ROW_SELECT,
  RequestListLoader,
  type ListDb,
  type ListRow,
} from './request-list.loader';
import { RequestSnapshotLoader, type RequestDb } from './snapshot.loader';

const now = new Date('2026-10-23T10:00:00.000Z');
const at = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`);

const R1 = '00000000-0000-4000-8000-000000000001';
const R2 = '00000000-0000-4000-8000-000000000002';
const R3 = '00000000-0000-4000-8000-000000000003';

const base = (overrides: Record<string, unknown>) => ({
  id: 'r',
  number: 1,
  ownerId: 'c1',
  staffOwnerId: null,
  title: 'Kitchen renovation',
  service: 'Construction',
  status: 'submitted',
  version: 4,
  intakeState: 'approved',
  contactInBrief: false,
  holdKind: null,
  defectsWindowEndsAt: null,
  reportApprovedAt: null,
  createdAt: at(1),
  updatedAt: at(2),
  cityId: 'city-1',
  districtId: 'district-1',
  address: 'Not selected by the list',
  description: 'Not selected by the list',
  ...overrides,
});

const quote = (requestId: string, overrides: Record<string, unknown>) => ({
  requestId,
  approvalRequestedAt: null,
  validUntil: null,
  payoutAmount: null,
  payoutAssignmentId: null,
  basedOnAssignmentId: null,
  acceptedAt: null,
  providerChangedAt: null,
  version: 1,
  ...overrides,
});

const requests = [
  base({
    id: R1,
    number: 1,
    status: 'scheduled',
    staffOwnerId: 's1',
    version: 9,
  }),
  base({ id: R2, number: 2, status: 'in_progress', ownerId: 'c2' }),
  base({ id: R3, number: 3, status: 'under_review', ownerId: 'c3' }),
];

const tables = {
  assignments: [
    {
      requestId: R1,
      id: 'a1',
      providerId: 'p1',
      providerUserId: 'pu1',
      status: 'accepted',
      attempt: 1,
      expiresAt: at(20),
      createdAt: at(3),
    },
    {
      requestId: R1,
      id: 'a0',
      providerId: 'p0',
      providerUserId: 'pu0',
      status: 'declined',
      attempt: 1,
      expiresAt: at(4),
      createdAt: at(2),
    },
    {
      requestId: R2,
      id: 'a2',
      providerId: 'p2',
      providerUserId: 'pu2',
      status: 'accepted',
      attempt: 2,
      expiresAt: at(21),
      createdAt: at(3),
    },
  ],
  quotes: [
    quote(R1, {
      id: 'q2',
      version: 2,
      status: 'accepted',
      payoutAmount: 90_000n,
      payoutAssignmentId: 'a1',
      acceptedAt: at(5),
    }),
    quote(R1, { id: 'q1', version: 1, status: 'superseded' }),
    quote(R2, { id: 'q3', version: 1, status: 'accepted' }),
  ],
  schedules: [
    {
      requestId: R1,
      id: 'sc1',
      assignmentId: 'a1',
      status: 'proposed',
      startAt: at(25),
      endAt: at(26),
      customer: 'accepted',
      provider: 'pending',
      changeRequests: [{ handledAt: null }],
      replacesScheduleId: 'sc0',
      proposedAt: at(8),
    },
    {
      requestId: R1,
      id: 'sc0',
      assignmentId: 'a1',
      status: 'confirmed',
      startAt: at(24),
      endAt: at(24),
      customer: 'accepted',
      provider: 'accepted',
      changeRequests: [],
      replacesScheduleId: null,
      proposedAt: at(6),
    },
  ],
  updates: [
    {
      requestId: R2,
      kind: 'progress',
      state: 'pending',
      createdAt: at(9),
    },
    {
      requestId: R2,
      kind: 'start',
      state: 'approved',
      createdAt: at(8),
    },
  ],
  issues: [
    { requestId: R2, status: 'rework' },
    { requestId: R2, status: 'resolved' },
  ],
  cancellations: [
    {
      requestId: R1,
      id: 'x1',
      status: 'pending',
      requestedBy: 'customer',
      paid: true,
      workStarted: false,
    },
    {
      requestId: R1,
      id: 'x0',
      status: 'declined',
      requestedBy: 'customer',
      paid: true,
      workStarted: false,
    },
  ],
  noShows: [
    { requestId: R2, status: 'open', detectedAt: at(9) },
    { requestId: R2, status: 'dismissed', detectedAt: at(7) },
  ],
  contributions: [{ requestId: R2, assignmentId: 'a2' }],
  timers: [{ requestId: R3, kind: 'dispatch.cascade', status: 'pending' }],
  payments: [
    { requestId: R1, status: 'paid', createdAt: at(6), quoteId: 'q2' },
    { requestId: R2, status: 'pending', createdAt: at(6), quoteId: 'q3' },
  ],
  refunds: [
    { requestId: R2, status: 'pending_approval' },
    { requestId: R2, status: 'processing' },
    { requestId: R2, status: 'completed' },
  ],
  profiles: [
    {
      userId: 'pu1',
      trade: 'Plumbing',
      verification: 'approved',
      reliabilityStatus: 'normal',
      user: { firstName: 'Pat', lastName: 'One' },
    },
    {
      userId: 'pu2',
      trade: 'Tiling',
      verification: 'approved',
      reliabilityStatus: 'restricted',
      user: { firstName: 'Tim', lastName: 'Two' },
    },
  ],
  users: [
    { id: 'c1', status: 'active' },
    { id: 'c2', status: 'suspended' },
    { id: 'c3', status: 'active' },
    { id: 'pu1', status: 'suspended' },
    { id: 'pu2', status: 'active' },
  ],
};

type Where = { requestId?: string | { in: string[] } };
const forRequests = <T extends { requestId: string }>(
  rows: T[],
  where: Where,
) => {
  const ids = where.requestId;
  return rows.filter((row) =>
    typeof ids === 'string'
      ? row.requestId === ids
      : (ids?.in ?? []).includes(row.requestId),
  );
};

function fakeDb() {
  const byDesc = <T>(rows: T[], key: (row: T) => number) =>
    [...rows].sort((a, b) => key(b) - key(a));
  const db = {
    serviceRequest: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const row = requests.find((item) => item.id === where.id)!;
        const own = <T extends { requestId: string }>(rows: T[]) =>
          rows.filter((item) => item.requestId === row.id);
        return Promise.resolve({
          ...row,
          attachments: [],
          assignments: own(tables.assignments).sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          ),
          runs: [],
          contributions: own(tables.contributions),
          quotes: byDesc(own(tables.quotes), (item) => item.version),
          schedules: byDesc(own(tables.schedules), (item) =>
            item.proposedAt.getTime(),
          ),
          updates: byDesc(own(tables.updates), (item) =>
            item.createdAt.getTime(),
          ),
          issues: own(tables.issues),
          cancellations: own(tables.cancellations),
          noShows: byDesc(own(tables.noShows), (item) =>
            item.detectedAt.getTime(),
          ),
          messages: [],
        });
      }),
    },
    providerProfile: {
      findUnique: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          tables.profiles.find((item) => item.userId === where.userId) ?? null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { userId: { in: string[] } } }) =>
        Promise.resolve(
          tables.profiles.filter((item) =>
            where.userId.in.includes(item.userId),
          ),
        ),
      ),
    },
    location: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Lagos' }),
    },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          tables.users.find((item) => item.id === where.id) ?? null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          tables.users.filter((item) => where.id.in.includes(item.id)),
        ),
      ),
    },
    requestTimer: {
      findFirst: jest.fn(({ where }: { where: { requestId: string } }) =>
        Promise.resolve(
          tables.timers.find((item) => item.requestId === where.requestId)
            ? { id: 't' }
            : null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(forRequests(tables.timers, where)),
      ),
    },
    upload: { findMany: jest.fn().mockResolvedValue([]) },
    payment: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          byDesc(forRequests(tables.payments, where), (item) =>
            item.createdAt.getTime(),
          ),
        ),
      ),
    },
    refund: {
      count: jest.fn(({ where }: { where: { requestId: string } }) =>
        Promise.resolve(
          tables.refunds.filter(
            (item) =>
              item.requestId === where.requestId &&
              !['completed', 'waived', 'rejected'].includes(item.status),
          ).length,
        ),
      ),
      groupBy: jest.fn(({ where }: { where: Where }) => {
        const open = forRequests(tables.refunds, where).filter(
          (item) => !['completed', 'waived', 'rejected'].includes(item.status),
        );
        return Promise.resolve(
          [...new Set(open.map((item) => item.requestId))].map((requestId) => ({
            requestId,
            _count: {
              _all: open.filter((item) => item.requestId === requestId).length,
            },
          })),
        );
      }),
    },
    assignment: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          forRequests(tables.assignments, where).sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          ),
        ),
      ),
    },
    quote: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          byDesc(forRequests(tables.quotes, where), (item) => item.version),
        ),
      ),
    },
    schedule: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          byDesc(forRequests(tables.schedules, where), (item) =>
            item.proposedAt.getTime(),
          ),
        ),
      ),
    },
    progressUpdate: {
      findMany: jest.fn(({ where }: { where: Where & { state: string } }) =>
        Promise.resolve(
          byDesc(
            forRequests(tables.updates, where).filter(
              (item) => item.state === where.state,
            ),
            (item) => item.createdAt.getTime(),
          ),
        ),
      ),
    },
    issue: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          forRequests(tables.issues, where).filter(
            (item) => item.status !== 'resolved',
          ),
        ),
      ),
    },
    cancellation: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          forRequests(tables.cancellations, where).filter(
            (item) => item.status === 'pending',
          ),
        ),
      ),
    },
    noShow: {
      findMany: jest.fn(({ where }: { where: Where }) => {
        const latest = new Map<string, (typeof tables.noShows)[number]>();
        for (const item of byDesc(forRequests(tables.noShows, where), (row) =>
          row.detectedAt.getTime(),
        ))
          if (!latest.has(item.requestId)) latest.set(item.requestId, item);
        return Promise.resolve([...latest.values()]);
      }),
    },
    contribution: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(forRequests(tables.contributions, where)),
      ),
    },
  };
  return db;
}

const staff: ActorContext = {
  userId: 'staff-1',
  kind: 'staff',
  displayName: 'Staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    roles: [],
    permissions: new Set([
      'dispatch.manage',
      'schedule.manage',
      'request.cancel',
      'message.customer',
    ]),
    canOwn: true,
    isSuperAdmin: false,
    permVersion: 1,
  },
};
const customer = (userId: string): ActorContext => ({
  userId,
  kind: 'customer',
  displayName: 'Customer',
  platformRoles: ['customer'],
  accountActive: true,
});
const provider = (userId: string): ActorContext => ({
  userId,
  kind: 'provider',
  displayName: 'Provider',
  platformRoles: ['provider'],
  accountActive: true,
});

const settings = { 'assignment.maxAutoAttempts': 3 };

describe('RequestListLoader', () => {
  async function both() {
    const db = fakeDb();
    const full = [];
    for (const { id } of requests) {
      full.push(
        (await new RequestSnapshotLoader().load(
          db as unknown as RequestDb,
          id,
        ))!,
      );
    }
    jest.clearAllMocks();
    const rows = requests.map((request) =>
      Object.fromEntries(
        Object.keys(LIST_ROW_SELECT).map((key) => [
          key,
          request[key as keyof typeof request],
        ]),
      ),
    ) as unknown as ListRow[];
    const light = await new RequestListLoader().attachSnapshots(
      db as unknown as ListDb,
      rows,
    );
    return { db, full, light };
  }

  it('builds the same snapshot as the full loader, minus names and attachments the summary never reads', async () => {
    const { full, light } = await both();
    expect(light).toHaveLength(3);
    light.forEach((item, index) => {
      expect(item.snapshot).toEqual({
        ...full[index].snapshot,
        cityName: null,
        districtName: null,
        attachmentInfo: [],
      });
    });
  });

  it.each([
    ['staff', staff],
    ['the owning customer', customer('c1')],
    ['a customer on a suspended account', customer('c2')],
    ['the assigned provider', provider('pu1')],
  ])(
    'projects the same summary as the detail-derived one for %s',
    async (_, actor) => {
      const { full, light } = await both();
      light.forEach((item, index) => {
        expect(
          listProjection(item.row, item.snapshot, actor, now, settings),
        ).toEqual(
          listProjection(
            full[index].row,
            full[index].snapshot,
            actor,
            now,
            settings,
          ),
        );
      });
    },
  );

  it('derives the expected stages for the fixture', async () => {
    const { light } = await both();
    const stages = light.map(
      (item) =>
        listProjection(item.row, item.snapshot, staff, now, settings).stage,
    );
    expect(stages).toEqual(['reschedule', 'rework', 'dispatching']);
  });

  it('runs one batched query per child table for the whole page, not per row', async () => {
    const { db } = await both();
    for (const model of [
      'assignment',
      'quote',
      'schedule',
      'progressUpdate',
      'issue',
      'cancellation',
      'noShow',
      'contribution',
      'requestTimer',
      'payment',
    ] as const) {
      expect(db[model].findMany).toHaveBeenCalledTimes(1);
    }
    expect(db.refund.groupBy).toHaveBeenCalledTimes(1);
    expect(db.providerProfile.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.serviceRequest.findUnique).not.toHaveBeenCalled();
    expect(db.upload.findMany).toHaveBeenCalledTimes(0);
    expect(db.location.findUnique).not.toHaveBeenCalled();
  });

  it('selects only summary columns from service_requests', () => {
    expect(Object.keys(LIST_ROW_SELECT)).not.toEqual(
      expect.arrayContaining(['address', 'description', 'details', 'phone']),
    );
  });

  it('returns nothing for an empty page without querying', async () => {
    const db = fakeDb();
    expect(
      await new RequestListLoader().attachSnapshots(
        db as unknown as ListDb,
        [],
      ),
    ).toEqual([]);
    expect(db.assignment.findMany).not.toHaveBeenCalled();
  });
});
