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
          options: any,
          fn: (value: typeof context) => Promise<void>,
        ) => {
          await fn({ ...(context as any), actor: options.actor });
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
});
