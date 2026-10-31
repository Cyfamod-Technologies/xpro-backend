import { loadGroupView, type RequestGroupViewDb } from './request-group-view';

const now = new Date('2026-10-30T10:00:00.000Z');
const siblingRow = (
  number: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `uuid-${number}`,
  number,
  title: `Bathroom — Job ${number}`,
  service: 'Construction',
  servicePath: [
    { id: 'root', name: 'Construction' },
    { id: `leaf-${number}`, name: `Job ${number}` },
  ],
  status: 'submitted',
  ...overrides,
});

function setup(
  requests: unknown[],
  group: unknown = { id: 'g1', ref: 'XPG-00001', title: 'Bathroom' },
) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(group ? { ...group, requests } : null);
  const attachSnapshots = jest.fn(
    (_db: unknown, rows: Array<{ status: string }>) =>
      Promise.resolve(
        rows.map((row) => ({
          row,
          snapshot: {
            status: row.status,
            intake: { state: 'pending' },
            currentAssignment: null,
            pendingCancellation: false,
            quotes: [],
            pendingUpdates: [],
            openIssues: [],
            schedules: [],
          },
        })),
      ),
  );
  const db = { requestGroup: { findUnique } } as unknown as RequestGroupViewDb;
  return { db, findUnique, attachSnapshots };
}

describe('loadGroupView', () => {
  it('returns no group and no siblings for an ungrouped request without querying', async () => {
    const { db, findUnique, attachSnapshots } = setup([]);
    await expect(
      loadGroupView(
        db,
        { attachSnapshots } as never,
        { id: 'r1', groupId: null, ownerId: 'c1' },
        'customer',
        now,
      ),
    ).resolves.toEqual({ group: null, siblings: [] });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lists the other requests in groupPosition order, excluding the request itself', async () => {
    const { db, findUnique, attachSnapshots } = setup([
      siblingRow(2),
      siblingRow(3, { servicePath: null }),
    ]);
    const view = await loadGroupView(
      db,
      { attachSnapshots } as never,
      { id: 'uuid-1', groupId: 'g1', ownerId: 'c1' },
      'staff',
      now,
    );
    expect(view.group).toEqual({
      id: 'g1',
      ref: 'XPG-00001',
      title: 'Bathroom',
    });
    expect(view.siblings.map(({ id }) => id)).toEqual([
      'XPR-00002',
      'XPR-00003',
    ]);
    expect(view.siblings[0]).toEqual({
      id: 'XPR-00002',
      title: 'Bathroom — Job 2',
      serviceName: 'Job 2',
      status: 'submitted',
      stage: 'intake_review',
    });
    expect(view.siblings[1].serviceName).toBe('Construction');
    const args = (findUnique.mock.calls as unknown[][])[0][0] as {
      where: unknown;
      select: { requests: { where: unknown; orderBy: unknown } };
    };
    expect(args.select.requests.orderBy).toEqual([
      { groupPosition: 'asc' },
      { id: 'asc' },
    ]);
    expect(args.select.requests.where).toEqual({ id: { not: 'uuid-1' } });
  });

  it('limits a customer to their own requests of the group', async () => {
    const { db, findUnique, attachSnapshots } = setup([]);
    await loadGroupView(
      db,
      { attachSnapshots } as never,
      { id: 'uuid-1', groupId: 'g1', ownerId: 'c1' },
      'customer',
      now,
    );
    const args = (findUnique.mock.calls as unknown[][])[0][0] as {
      select: { requests: { where: unknown } };
    };
    expect(args.select.requests.where).toEqual({
      id: { not: 'uuid-1' },
      ownerId: 'c1',
    });
  });

  it('treats a missing group row as ungrouped', async () => {
    const { db, attachSnapshots } = setup([], null);
    await expect(
      loadGroupView(
        db,
        { attachSnapshots } as never,
        { id: 'r1', groupId: 'gone', ownerId: 'c1' },
        'staff',
        now,
      ),
    ).resolves.toEqual({ group: null, siblings: [] });
  });
});
