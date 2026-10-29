import type { ActorContext } from '../platform/actor/actor.types';
import { RequestCommandRunner } from './command-runner';

describe('RequestCommandRunner idempotency', () => {
  it('serializes concurrent commands with the same key and replays the committed response', async () => {
    let lockTail = Promise.resolve();
    const acquireLock = async () => {
      let release!: () => void;
      const previous = lockTail;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return release;
    };

    const actor: ActorContext = {
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    };
    const row = {
      id: 'request-1',
      ownerId: actor.userId,
      version: 1,
      status: 'submitted',
      staffOwnerId: null,
      ownershipVersion: 1,
    };
    const snapshot = { ownerId: actor.userId };
    let stored: { status: number; body: unknown } | null = null;
    const idempotency = {
      lookup: jest.fn(
        (_actorId: string, _key: string, _hash: string, tx?: unknown) =>
          Promise.resolve(tx ? stored : null),
      ),
      store: jest.fn(
        (
          _actorId: string,
          _key: string,
          _hash: string,
          status: number,
          body: unknown,
          tx?: unknown,
        ) => {
          expect(tx).toBeDefined();
          stored = { status, body };
          return Promise.resolve();
        },
      ),
    };
    const loader = {
      load: jest.fn(() => Promise.resolve({ row, snapshot })),
    };
    let transactionCount = 0;
    let secondLockStarted!: () => void;
    const secondLockWaiting = new Promise<void>((resolve) => {
      secondLockStarted = resolve;
    });
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          transactionCount += 1;
          let release: (() => void) | undefined;
          const tx = {
            $executeRaw: jest.fn(async () => {
              if (transactionCount === 2) secondLockStarted();
              release = await acquireLock();
              return [];
            }),
            serviceRequest: {
              update: jest.fn(() => {
                row.version += 1;
                return Promise.resolve(row);
              }),
            },
          };
          try {
            return await callback(tx);
          } finally {
            release?.();
          }
        },
      ),
    };
    const runner = new RequestCommandRunner(
      prisma as never,
      loader as never,
      { snapshot: jest.fn().mockResolvedValue([]) } as never,
      idempotency as never,
      {} as never,
      { kick: jest.fn() } as never,
      { kick: jest.fn() } as never,
      {} as never,
    );
    const projected = jest.fn((loadedRow: typeof row) => ({
      id: 'XPR-00042',
      version: loadedRow.version,
    }));
    (runner as unknown as { project: typeof projected }).project = projected;

    let releaseCommand!: () => void;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const command = jest.fn(async () => {
      if (command.mock.calls.length === 1) {
        commandStarted();
        await commandGate;
      }
      return { status: 200 };
    });
    const options = {
      command: 'request.review',
      guard: null,
      actor,
      requestRef: 'XPR-00042',
      idempotencyKey: 'same-key-1234',
      idempotencyHash: 'same-payload-hash',
    };

    const first = runner.run(options, command as never);
    await started;
    const second = runner.run(options, command as never);
    await secondLockWaiting;
    releaseCommand();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(command).toHaveBeenCalledTimes(1);
    expect(idempotency.store).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(secondResult.body).toEqual({ id: 'XPR-00042', version: 2 });
    expect(secondResult.etag).toBe('W/"2"');
  });
});
