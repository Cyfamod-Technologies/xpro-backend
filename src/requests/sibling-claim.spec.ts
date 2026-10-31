import { Prisma } from '@prisma/client';
import { claimGroupSiblings } from './sibling-claim';

const now = new Date('2026-10-30T12:00:00Z');

function setup(
  siblings: Array<{ id: string; ownershipVersion: number }>,
  claimable: (id: string) => boolean = () => true,
) {
  const log: string[] = [];
  const tx = {
    $queryRaw: jest.fn((_query: Prisma.Sql) => {
      log.push('lock');
      return Promise.resolve(siblings);
    }),
    serviceRequest: {
      findMany: jest.fn(),
      updateMany: jest.fn((args: { where: { id: string } }) => {
        log.push(`update:${args.where.id}`);
        return Promise.resolve({ count: claimable(args.where.id) ? 1 : 0 });
      }),
    },
    auditLog: {
      create: jest.fn(() => Promise.resolve({})),
    },
  };
  const hooks = {
    close: jest.fn((_tx: unknown, _kind: string, id: string) => {
      log.push(`close:${id}`);
      return Promise.resolve();
    }),
  };
  const run = (action: 'request.claimed' | 'request.auto_claimed') =>
    claimGroupSiblings(tx as never, hooks, {
      groupId: 'group-1',
      trigger: { id: 'uuid-1', number: 1 },
      staffId: 'staff-1',
      actorType: 'staff',
      now,
      action,
      command:
        action === 'request.claimed' ? 'request.claim' : 'request.review',
    });
  return { tx, hooks, log, run };
}

describe('claimGroupSiblings (02 §6.5 bundles)', () => {
  it('claims every open unowned sibling for the same staff member', async () => {
    const { tx, hooks, run } = setup([
      { id: 'a', ownershipVersion: 3 },
      { id: 'b', ownershipVersion: 1 },
    ]);
    await expect(run('request.claimed')).resolves.toEqual(['a', 'b']);
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'a',
        staffOwnerId: null,
        ownershipVersion: 3,
        status: { notIn: ['closed', 'cancelled', 'rejected'] },
      },
      data: {
        staffOwnerId: 'staff-1',
        claimedAt: now,
        unclaimedSince: null,
        ownershipVersion: { increment: 1 },
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    expect(hooks.close).toHaveBeenCalledWith(
      tx,
      'unclaimed',
      'a',
      now,
      'claimed',
    );
    expect(hooks.close).toHaveBeenCalledWith(
      tx,
      'unclaimed',
      'b',
      now,
      'claimed',
    );
  });

  it('claims nothing, and never reads the siblings again, when the lock returns no rows', async () => {
    const { tx, hooks, run } = setup([]);
    await expect(run('request.claimed')).resolves.toEqual([]);
    expect(tx.serviceRequest.findMany).not.toHaveBeenCalled();
    expect(tx.serviceRequest.updateMany).not.toHaveBeenCalled();
    expect(hooks.close).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('never updates a sibling the lock skipped because another transaction holds it', async () => {
    // The group has a, b and c; b is locked elsewhere, so the lock query returns a and c only.
    const { tx, hooks, run } = setup([
      { id: 'a', ownershipVersion: 3 },
      { id: 'c', ownershipVersion: 2 },
    ]);
    await expect(run('request.claimed')).resolves.toEqual(['a', 'c']);
    const updated = tx.serviceRequest.updateMany.mock.calls.map(
      ([args]) => args.where.id,
    );
    expect(updated).toEqual(['a', 'c']);
    expect(hooks.close).not.toHaveBeenCalledWith(
      tx,
      'unclaimed',
      'b',
      expect.anything(),
      expect.anything(),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.serviceRequest.findMany).not.toHaveBeenCalled();
  });

  it('writes one request.claimed audit row per claimed sibling with the trigger id in the note', async () => {
    const { tx, run } = setup([
      { id: 'a', ownershipVersion: 3 },
      { id: 'b', ownershipVersion: 1 },
    ]);
    await run('request.claimed');
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(1, {
      data: {
        actorType: 'staff',
        actorId: 'staff-1',
        entityType: 'service_request',
        entityId: 'a',
        action: 'request.claimed',
        metadata: {
          requestId: 'a',
          command: 'request.claim',
          note: 'with XPR-00001 in the same project',
          changes: {
            before: { staffOwnerId: null },
            after: { staffOwnerId: 'staff-1' },
          },
        },
      },
    });
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ entityId: 'b' }) as unknown,
      }),
    );
  });

  it('writes request.auto_claimed rows and the auto_claimed close reason for an auto-claim', async () => {
    const { tx, hooks, run } = setup([{ id: 'a', ownershipVersion: 3 }]);
    await run('request.auto_claimed');
    expect(hooks.close).toHaveBeenCalledWith(
      tx,
      'unclaimed',
      'a',
      now,
      'auto_claimed',
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'request.auto_claimed',
        metadata: {
          requestId: 'a',
          command: 'request.review',
          note: 'with XPR-00001 in the same project',
          before: { staffOwnerId: null },
          after: { staffOwnerId: 'staff-1' },
        },
      }) as unknown,
    });
  });

  it('skips a sibling whose compare-and-set lost: no approval close and no audit row', async () => {
    const { tx, hooks, run } = setup(
      [
        { id: 'a', ownershipVersion: 3 },
        { id: 'b', ownershipVersion: 1 },
      ],
      (id) => id !== 'a',
    );
    await expect(run('request.claimed')).resolves.toEqual(['b']);
    expect(hooks.close).toHaveBeenCalledTimes(1);
    expect(hooks.close).toHaveBeenCalledWith(
      tx,
      'unclaimed',
      'b',
      now,
      'claimed',
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('locks with SKIP LOCKED in ascending id order, then claims exactly the returned ids in that order', async () => {
    const { tx, log, run } = setup([
      { id: 'a', ownershipVersion: 3 },
      { id: 'b', ownershipVersion: 1 },
    ]);
    await run('request.claimed');
    const [query] = tx.$queryRaw.mock.calls[0];
    expect(query.sql).toContain('ORDER BY id FOR UPDATE SKIP LOCKED');
    expect(query.sql).toContain('staff_owner_id IS NULL');
    expect(query.sql).not.toMatch(/uuid/i);
    expect(query.values).toEqual(['group-1', 'uuid-1']);
    expect(log[0]).toBe('lock');
    expect(log.filter((entry) => entry.startsWith('update:'))).toEqual([
      'update:a',
      'update:b',
    ]);
  });
});
