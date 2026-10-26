import type { ActorContext } from '../platform/actor/actor.types';
import { ENGINE_ACTOR, SYSTEM_ACTOR } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { RequestCommandRunner } from './command-runner';

const customer: ActorContext = {
  userId: 'customer-1',
  kind: 'customer',
  displayName: 'Customer',
  platformRoles: ['customer'],
  accountActive: true,
};

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the promise to reject.');
}

function setup(snapshotOverrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const row = {
    id: 'request-1',
    ownerId: 'customer-1',
    version: 3,
    status: 'submitted',
    staffOwnerId: null,
    ownershipVersion: 1,
  };
  const snapshot = { ownerId: 'customer-1', ...snapshotOverrides };
  const tx = {
    serviceRequest: {
      update: jest.fn(() => {
        calls.push('bump');
        return Promise.resolve(row);
      }),
    },
    auditLog: {
      createMany: jest.fn(() => {
        calls.push('audit');
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (transaction: unknown) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const loader = { load: jest.fn(() => Promise.resolve({ row, snapshot })) };
  const timers = {
    start: jest.fn((_tx: unknown, input: { kind: string; refId?: string }) => {
      calls.push(`start:${input.kind}`);
      return Promise.resolve({ id: 't', created: true });
    }),
    stop: jest.fn((_tx: unknown, input: { kinds: string[] }) => {
      calls.push(`stop:${input.kinds.join(',')}`);
      return Promise.resolve(1);
    }),
    kick: jest.fn(),
  };
  const outbox = { kick: jest.fn() };
  const dispatcher = {
    dispatch: jest.fn((_tx: unknown, event: string) => {
      calls.push(`notify:${event}`);
      return Promise.resolve();
    }),
  };
  const approvals = {
    open: jest.fn(
      (_tx: unknown, kind: string, itemId: string, requestId: string) => {
        calls.push(`open:${kind}:${itemId}:${requestId}`);
        return Promise.resolve();
      },
    ),
    close: jest.fn((_tx: unknown, kind: string, itemId: string) => {
      calls.push(`close:${kind}:${itemId}`);
      return Promise.resolve();
    }),
  };
  const runner = new RequestCommandRunner(
    prisma as never,
    loader as never,
    { snapshot: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    dispatcher as never,
    timers as never,
    outbox as never,
    approvals as never,
  );
  const project = jest.fn((loadedRow: typeof row) => ({
    id: 'XPR-00001',
    version: loadedRow.version,
  }));
  (runner as unknown as { project: typeof project }).project = project;
  const run = (
    fn: Parameters<RequestCommandRunner['run']>[1],
    extra: {
      expectedVersion?: number;
      command?: string;
      guard?: string | null;
      input?: unknown;
      actor?: ActorContext;
    } = {},
  ) =>
    runner.run(
      {
        command: 'request.test',
        actor: customer,
        requestRef: 'XPR-00001',
        // The fake command has no registry entry; the guard describe block below sets its own.
        guard: null,
        ...extra,
      },
      fn,
    );
  return {
    calls,
    row,
    tx,
    prisma,
    timers,
    outbox,
    approvals,
    dispatcher,
    runner,
    run,
  };
}

describe('RequestCommandRunner ordered effects', () => {
  it('stop then start of the same kind leaves a pending start applied after the stop', async () => {
    const { run, calls, timers } = setup();
    await run((ctx) => {
      ctx.timers.stop([TimerKinds.T6Reminder48h]);
      ctx.timers.start(TimerKinds.T6Reminder48h, new Date(Date.now() + 1000));
      return Promise.resolve();
    });

    expect(calls.filter((call) => /^(start|stop):/.test(call))).toEqual([
      'stop:T6.reminder48h',
      'start:T6.reminder48h',
    ]);
    const stopOrder = timers.stop.mock.invocationCallOrder[0];
    const startOrder = timers.start.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('start then stop leaves the timer stopped', async () => {
    const { run, calls } = setup();
    await run((ctx) => {
      ctx.timers.start(TimerKinds.T6Reminder48h, new Date(Date.now() + 1000));
      ctx.timers.stop(TimerKinds.T6Reminder48h);
      return Promise.resolve();
    });

    expect(calls.filter((call) => /^(start|stop):/.test(call))).toEqual([
      'start:T6.reminder48h',
      'stop:T6.reminder48h',
    ]);
  });

  it('replays approval open and close interleaved with timers in call order', async () => {
    const { run, calls } = setup();
    await run((ctx) => {
      ctx.approvals.open('intake', 'item-1');
      ctx.timers.start(TimerKinds.T3Review, new Date(Date.now() + 1000));
      ctx.approvals.close('intake', 'item-1', 'approved');
      ctx.timers.stop(TimerKinds.T3Review);
      ctx.approvals.open('quote_review', 'item-2');
      return Promise.resolve();
    });

    expect(calls.filter((call) => !/^(bump|audit)$/.test(call))).toEqual([
      'open:intake:item-1:request-1',
      'start:T3.review',
      'close:intake:item-1',
      'stop:T3.review',
      'open:quote_review:item-2:request-1',
    ]);
  });

  it('does not flush effects when the command reports no change', async () => {
    const { run, calls } = setup();
    await run((ctx) => {
      ctx.timers.start(TimerKinds.T6Reminder48h, new Date(Date.now() + 1000));
      ctx.approvals.open('intake', 'item-1');
      return Promise.resolve({ changed: false });
    });
    expect(calls).toEqual([]);
  });
});

describe('RequestCommandRunner 409 enrichment', () => {
  it('adds details.current to a guard 409 without details', async () => {
    const { run } = setup();
    const conflict = await rejection(
      run(() => {
        throw new AppError(409, 'STATE_CONFLICT', 'Not in this state.');
      }),
    );

    expect(conflict.getStatus()).toBe(409);
    expect(conflict.code).toBe('STATE_CONFLICT');
    expect(conflict.message).toBe('Not in this state.');
    expect(conflict.details).toEqual({
      current: { id: 'XPR-00001', version: 3 },
    });
  });

  it('keeps details that a 409 already carries and leaves other statuses alone', async () => {
    const { run } = setup();
    const withDetails = await rejection(
      run(() => {
        throw new AppError(409, 'STATE_CONFLICT', 'Busy.', { reason: 'x' });
      }),
    );
    expect(withDetails.details).toEqual({ reason: 'x' });

    const forbidden = await rejection(
      run(() => {
        throw new AppError(403, 'FORBIDDEN', 'No.');
      }),
    );
    expect(forbidden.details).toBeUndefined();
  });
});

describe('RequestCommandRunner If-Match', () => {
  it('skips the version check when no expected version is given', async () => {
    const { run, tx } = setup();
    const command = jest.fn(() => Promise.resolve());
    await run(command);
    expect(command).toHaveBeenCalledTimes(1);
    expect(tx.serviceRequest.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale expected version with VERSION_CONFLICT and details.current', async () => {
    const { run, tx } = setup();
    const command = jest.fn(() => Promise.resolve());
    const error = await rejection(run(command, { expectedVersion: 2 }));
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.getStatus()).toBe(409);
    expect(error.details).toEqual({ current: { id: 'XPR-00001', version: 3 } });
    expect(command).not.toHaveBeenCalled();
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('accepts a matching expected version', async () => {
    const { run } = setup();
    const command = jest.fn(() => Promise.resolve());
    await run(command, { expectedVersion: 3 });
    expect(command).toHaveBeenCalledTimes(1);
  });
});

describe('RequestCommandRunner.runSystem', () => {
  it('rolls back with no bump, audit, notification or effects when nothing changed', async () => {
    const { runner, calls, tx, timers, outbox } = setup();
    // The transaction mock only rolls back by propagating the thrown sentinel, as Prisma does.
    const result = await runner.runSystem('timer.t6', 'request-1', (ctx) => {
      ctx.audit('t6.fired');
      ctx.notify('t6.reminder', {});
      ctx.timers.start(TimerKinds.T6Reminder48h, new Date(0));
      ctx.approvals.open('intake', 'item-1');
      return Promise.resolve({ changed: false });
    });

    expect(result).toEqual({ changed: false });
    expect(calls).toEqual([]);
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(timers.kick).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('bumps the version and flushes effects as the system actor when something changed', async () => {
    const { runner, calls, timers, tx } = setup();
    const seen: ActorContext[] = [];
    const result = await runner.runSystem('timer.t6', 'request-1', (ctx) => {
      seen.push(ctx.actor);
      ctx.audit('t6.fired');
      ctx.timers.start(TimerKinds.T6Staff5d, new Date(0));
      return Promise.resolve();
    });

    expect(result).toEqual({ changed: true, version: 3 });
    expect(seen[0]).toBe(SYSTEM_ACTOR);
    expect(calls).toEqual(['bump', 'audit', 'start:T6.staff5d']);
    expect(tx.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          actorType: 'system',
          actorId: null,
          metadata: expect.objectContaining({
            requestId: 'request-1',
            command: 'timer.t6',
          }) as unknown,
        }),
      ],
    });
    expect(timers.kick).toHaveBeenCalledTimes(1);
  });

  it('skips the version bump but still flushes effects when bumpVersion is false', async () => {
    const { runner, calls, tx, outbox } = setup();
    const result = await runner.runSystem(
      'timer.reminder',
      'request-1',
      (ctx) => {
        ctx.notify('t6.reminder', {});
        return Promise.resolve();
      },
      { bumpVersion: false },
    );

    expect(result).toEqual({ changed: true, version: 3 });
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(calls).toEqual(['notify:t6.reminder']);
    expect(outbox.kick).toHaveBeenCalledTimes(1);
  });

  it('lets a result override the bumpVersion option', async () => {
    const { runner, tx } = setup();
    await runner.runSystem('timer.rearm', 'request-1', (ctx) => {
      ctx.timers.start(TimerKinds.T13NoShowCheck, new Date(0), 'schedule-1');
      return Promise.resolve({ bumpVersion: false });
    });
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('uses the engine actor when asked', async () => {
    const { runner } = setup();
    const seen: ActorContext[] = [];
    await runner.runSystem(
      'dispatch.cascade',
      'request-1',
      (ctx) => {
        seen.push(ctx.actor);
        return Promise.resolve();
      },
      { actor: ENGINE_ACTOR },
    );
    expect(seen[0]).toBe(ENGINE_ACTOR);
  });
});

describe('RequestCommandRunner.runInTx', () => {
  it('uses the caller transaction without opening its own and defers the kicks', async () => {
    const { runner, prisma, calls, timers } = setup();
    const outerTx = {
      serviceRequest: {
        update: jest.fn(() => {
          calls.push('outer-bump');
          return Promise.resolve({});
        }),
      },
    };
    const result = await runner.runInTx(
      outerTx as never,
      {
        command: 'payment.settled',
        actor: SYSTEM_ACTOR,
        requestRef: 'r',
        guard: null,
      },
      (ctx) => {
        expect(ctx.tx).toBe(outerTx);
        ctx.timers.start(TimerKinds.T9Lapse, new Date(0));
        return Promise.resolve();
      },
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(calls).toEqual(['outer-bump', 'start:T9.lapse']);
    expect(timers.kick).not.toHaveBeenCalled();
    await result.afterCommit();
    expect(timers.kick).toHaveBeenCalledTimes(1);
  });

  it('checks a given expected version and skips the check when absent', async () => {
    const { runner } = setup();
    const outerTx = {
      serviceRequest: { update: jest.fn().mockResolvedValue({}) },
    };
    const options = {
      command: 'payment.settled',
      actor: SYSTEM_ACTOR,
      requestRef: 'r',
      guard: null,
    };
    const stale = await rejection(
      runner.runInTx(outerTx as never, { ...options, expectedVersion: 1 }, () =>
        Promise.resolve(),
      ),
    );
    expect(stale.code).toBe('VERSION_CONFLICT');

    const ok = await runner.runInTx(outerTx as never, options, () =>
      Promise.resolve(),
    );
    expect(ok.changed).toBe(true);
  });

  it('routes notices with the staff owner loaded before the command, not the customer', async () => {
    const { run, row, dispatcher } = setup();
    Object.assign(row, { staffOwnerId: 'staff-1' });
    await run((ctx) => {
      ctx.notify('assignment.accepted', { requestCode: 'XPR-00001' });
      return Promise.resolve();
    });

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'assignment.accepted',
      { requestCode: 'XPR-00001' },
      {
        requestId: 'request-1',
        ownerId: 'customer-1',
        staffOwnerId: 'staff-1',
        actorId: 'customer-1',
      },
    );
  });

  it('computes recipients before the auto-claim, so an unclaimed request still reaches every holder', async () => {
    const { runner, tx, dispatcher } = setup();
    const claim = jest.fn().mockResolvedValue({ count: 1 });
    Object.assign(tx.serviceRequest, { updateMany: claim });
    Object.assign(tx, { auditLog: { ...tx.auditLog, create: jest.fn() } });
    const staff: ActorContext = {
      userId: 'staff-2',
      kind: 'staff',
      displayName: 'Staff',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(),
        canOwn: true,
        isSuperAdmin: false,
        permVersion: 1,
      },
    };
    await runner.run(
      {
        command: 'request.review',
        actor: staff,
        requestRef: 'XPR-00001',
        autoClaim: true,
        // This test is about recipients and auto-claim, not the review guard.
        guard: null,
      },
      (ctx) => {
        ctx.notify('assignment.accepted', { requestCode: 'XPR-00001' });
        return Promise.resolve();
      },
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'assignment.accepted',
      expect.anything(),
      expect.objectContaining({ staffOwnerId: null, actorId: 'staff-2' }),
    );
  });
});

describe('RequestCommandRunner guard enforcement', () => {
  const dispatcher: ActorContext = {
    userId: 'staff-1',
    kind: 'staff',
    displayName: 'Dispatch',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: [],
      permissions: new Set(['dispatch.manage']),
      canOwn: true,
      isSuperAdmin: false,
      permVersion: 1,
    },
  };

  it('runs the registry guard for the command key after the version check and before the handler', async () => {
    const { run, tx } = setup({ status: 'under_review' });
    const command = jest.fn(() => Promise.resolve());
    const error = await rejection(
      run(command, { command: 'dispatch.setMode', guard: undefined }),
    );

    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Your staff role does not allow this action.');
    expect(command).not.toHaveBeenCalled();
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();

    const stale = await rejection(
      run(command, {
        command: 'dispatch.setMode',
        guard: undefined,
        expectedVersion: 1,
      }),
    );
    expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it('passes a failing 409 guard the caller projection as details.current', async () => {
    const { run } = setup({ status: 'closed' });
    const error = await rejection(
      run(() => Promise.resolve(), {
        command: 'dispatch.setMode',
        guard: undefined,
        actor: dispatcher,
      }),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe('This request is no longer open.');
    expect(error.details).toEqual({ current: { id: 'XPR-00001', version: 3 } });
  });

  it('hands the input to the guard and lets a passing guard through', async () => {
    const { run } = setup({ status: 'under_review' });
    const command = jest.fn(() => Promise.resolve());
    const invalid = await rejection(
      run(command, {
        command: 'dispatch.setMode',
        guard: undefined,
        actor: dispatcher,
        input: { mode: 'manual', note: 'x' },
      }),
    );
    expect(invalid.getStatus()).toBe(422);
    expect(invalid.message).toBe('Add a note explaining the change.');

    await run(command, {
      command: 'dispatch.setMode',
      guard: undefined,
      actor: dispatcher,
      input: { mode: 'manual', note: 'Customer asked for manual.' },
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('uses the guard option instead of the command key when one is given', async () => {
    const { run } = setup({ status: 'under_review' });
    const command = jest.fn(() => Promise.resolve());
    await run(command, {
      command: 'request.somethingElse',
      guard: 'dispatch.setMode',
      actor: dispatcher,
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('refuses to run a command that has no registry entry unless guard is null', async () => {
    const { run } = setup();
    const command = jest.fn(() => Promise.resolve());
    await expect(
      run(command, { command: 'request.unregistered', guard: undefined }),
    ).rejects.toThrow(
      /No request guard is registered for "request.unregistered"/,
    );
    expect(command).not.toHaveBeenCalled();

    await run(command, { command: 'request.unregistered', guard: null });
    expect(command).toHaveBeenCalledTimes(1);
  });
});

describe('RequestCommandRunner auto-claim (02 §6.5)', () => {
  const operations: ActorContext = {
    userId: 'staff-1',
    kind: 'staff',
    displayName: 'Ops',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: ['operations'],
      permissions: new Set(['request.cancel'] as const),
      canOwn: true,
      isSuperAdmin: false,
      permVersion: 1,
    },
  };

  function withClaim() {
    const kit = setup();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    Object.assign(kit.tx.serviceRequest, { updateMany });
    Object.assign(kit.tx.auditLog, { create: jest.fn() });
    return { ...kit, updateMany };
  }

  it('claims for the actor and closes the unclaimed item', async () => {
    const { run, calls, updateMany } = withClaim();

    await run(() => Promise.resolve(), {
      actor: operations,
      command: 'request.review',
      autoClaim: true,
    } as never);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ staffOwnerId: 'staff-1' }) as unknown,
      }),
    );
    expect(calls).toContain('close:unclaimed:request-1');
  });

  it('claims on a cancellation rejection but not on an approval', async () => {
    const reject = withClaim();
    await reject.run(() => Promise.resolve(), {
      actor: operations,
      command: 'cancellation.decide',
      input: { approve: false, note: 'Work has started.' },
      autoClaim: true,
    } as never);
    expect(reject.updateMany).toHaveBeenCalledTimes(1);

    const approve = withClaim();
    await approve.run(() => Promise.resolve(), {
      actor: operations,
      command: 'cancellation.decide',
      input: { approve: true },
      autoClaim: true,
    } as never);
    expect(approve.updateMany).not.toHaveBeenCalled();
    expect(approve.calls).not.toContain('close:unclaimed:request-1');
  });
});
