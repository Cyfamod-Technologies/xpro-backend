import { AppError } from '../platform/errors/app-error';
import type { ActorContext } from '../platform/actor/actor.types';
import { OwnershipService } from './ownership.service';

describe('OwnershipService', () => {
  it('returns an owner conflict when the compare-and-set no longer matches', async () => {
    const actor: ActorContext = {
      userId: 'ops-1',
      kind: 'staff',
      displayName: 'Operations',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: ['operations'],
        permissions: new Set(['request.reassign']),
        canOwn: true,
        isSuperAdmin: false,
        permVersion: 1,
      },
    };
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'request-1',
          status: 'submitted',
          staffOwnerId: 'owner-1',
          ownershipVersion: 4,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue({
          userId: 'target-1',
          roles: [{ role: 'operations' }],
          user: {
            firstName: 'Target',
            lastName: 'Owner',
            name: null,
            email: 'target@example.test',
          },
        }),
      },
    };
    const context = {
      tx,
      snap: {
        id: 'request-1',
        number: 'XPR-00001',
        status: 'submitted',
        staffOwnerId: 'owner-1',
      },
      now: new Date('2026-10-23T12:00:00Z'),
      audit: jest.fn(),
      notify: jest.fn(),
      timers: { start: jest.fn(), stop: jest.fn() },
      enqueueCascade: jest.fn(),
    };
    const runner = {
      run: jest.fn(
        async (
          options: { actor: ActorContext },
          fn: (
            value: typeof context & { actor: ActorContext },
          ) => Promise<void>,
        ) => {
          await fn({ ...context, actor: options.actor });
          return { status: 200, body: {}, etag: 'W/"2"' };
        },
      ),
    };
    const actors = { resolve: jest.fn().mockResolvedValue(actor) };
    const idempotency = { hashRequest: jest.fn().mockReturnValue('hash') };
    const service = new OwnershipService(
      actors as never,
      runner as never,
      idempotency as never,
    );

    await expect(
      service.reassign(
        { id: 'ops-1' } as never,
        'XPR-00001',
        {
          staffId: 'target-1',
          note: 'Rebalance workload',
          expectedOwnerId: 'owner-1',
        },
        1,
        '/requests/XPR-00001/reassign',
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          staffOwnerId: 'owner-1',
          ownershipVersion: 4,
        }) as unknown,
      }),
    );
  });
  it('leaves note validation to the runner guard so a 403 or 409 is never pre-empted (A-31)', async () => {
    const actor: ActorContext = {
      userId: 'staff-1',
      kind: 'staff',
      displayName: 'Staff',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: ['operations'],
        permissions: new Set(),
        canOwn: true,
        isSuperAdmin: false,
        permVersion: 1,
      },
    };
    const runner = {
      run: jest
        .fn()
        .mockResolvedValue({ status: 200, body: {}, etag: 'W/"2"' }),
    };
    const service = new OwnershipService(
      { resolve: jest.fn().mockResolvedValue(actor) } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
    );

    await service.release(
      { id: 'staff-1' } as never,
      'XPR-00001',
      { note: 'no', expectedOwnerId: 'owner-1' },
      1,
      '/requests/XPR-00001/release',
    );

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'request.release',
        input: { note: 'no', expectedOwnerId: 'owner-1' },
      }),
      expect.any(Function),
    );
  });
});

describe('OwnershipService unclaimed deadline (A-20, 02 §6.5-6.7)', () => {
  const staff: ActorContext = {
    userId: 'ops-1',
    kind: 'staff',
    displayName: 'Operations',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: ['operations'],
      permissions: new Set(['request.claim', 'request.reassign']),
      canOwn: true,
      isSuperAdmin: false,
      permVersion: 1,
    },
  };

  function setup(ownerId: string | null) {
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'request-1',
          status: 'submitted',
          staffOwnerId: ownerId,
          ownershipVersion: 2,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      requestMessage: { create: jest.fn() },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue({
          userId: 'target-1',
          roles: [{ role: 'operations' }],
          user: {
            firstName: 'Tara',
            lastName: 'Get',
            name: null,
            email: 't@x',
          },
        }),
      },
    };
    const opens: string[][] = [];
    const closes: string[][] = [];
    const context = {
      tx,
      snap: { id: 'request-1', number: 'XPR-00001', status: 'submitted' },
      now: new Date('2026-10-26T12:00:00Z'),
      audit: jest.fn(),
      notify: jest.fn(),
      approvals: {
        open: (kind: string, itemId: string) => opens.push([kind, itemId]),
        close: (kind: string, itemId: string, reason?: string) =>
          closes.push([kind, itemId, reason ?? '']),
      },
    };
    const runner = {
      run: jest.fn(
        async (
          options: { actor: ActorContext },
          fn: (value: unknown) => Promise<void>,
        ) => {
          await fn({ ...context, actor: options.actor });
          return { status: 200, body: {}, etag: 'W/"2"' };
        },
      ),
    };
    const service = new OwnershipService(
      { resolve: jest.fn().mockResolvedValue(staff) } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
    );
    return { service, opens, closes };
  }
  const user = { id: 'ops-1' } as never;

  it('closes the unclaimed item when the request is claimed', async () => {
    const { service, opens, closes } = setup(null);

    await service.claim(user, 'XPR-00001', 1, '/claim');

    expect(closes).toEqual([['unclaimed', 'request-1', 'claimed']]);
    expect(opens).toEqual([]);
  });

  it('starts the unclaimed deadline again when the owner releases the request', async () => {
    const { service, opens, closes } = setup('ops-1');

    await service.release(
      user,
      'XPR-00001',
      { note: 'Handing back to the queue.', expectedOwnerId: 'ops-1' },
      1,
      '/release',
    );

    expect(opens).toEqual([['unclaimed', 'request-1']]);
    expect(closes).toEqual([]);
  });

  it('closes the unclaimed item when an unclaimed request is reassigned', async () => {
    const { service, closes } = setup(null);

    await service.reassign(
      user,
      'XPR-00001',
      {
        staffId: 'target-1',
        note: 'Please take this.',
        expectedOwnerId: null,
      },
      1,
      '/reassign',
    );

    expect(closes).toEqual([['unclaimed', 'request-1', 'reassigned']]);
  });
});
