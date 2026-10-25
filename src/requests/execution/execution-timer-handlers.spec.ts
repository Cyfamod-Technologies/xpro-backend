import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { ExecutionTimerHandlers } from './execution-timer-handlers';

const now = new Date('2026-10-24T12:00:00.000Z');

function setup(
  snap: Record<string, unknown>,
  tx: Record<string, unknown> = {},
) {
  const kit = systemCommandKit({ now, tx, snap });
  const registry = new TimerRegistry();
  new ExecutionTimerHandlers(registry, kit.runner);
  const fire = (kind: string) =>
    registry.get(kind)?.(timerFixture(kind)) as Promise<void>;
  return { fire, ...kit };
}

describe('T15 and T16 execution timers', () => {
  it('T15.stale opens a progress item when an in-progress job has no pending update', async () => {
    const { fire, effects, runs } = setup({ status: 'in_progress' });

    await fire('T15.stale');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.approvalOpens).toEqual([
      { kind: 'progress', itemId: 'request-1' },
    ]);
    expect(effects.notify[0].event).toBe('progress.stale');
  });

  it.each([
    ['the job is not in progress', { status: 'blocked' }],
    [
      'an update already awaits review',
      {
        status: 'in_progress',
        pendingUpdates: [{ kind: 'progress', state: 'pending' }],
      },
    ],
  ])('T15.stale does nothing when %s', async (_name, snap) => {
    const { fire, effects, runs } = setup(snap);

    await fire('T15.stale');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.approvalOpens).toEqual([]);
    expect(effects.notify).toEqual([]);
  });

  describe('T15.escalate', () => {
    const tx = (existing: unknown) => ({
      requestEscalation: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
      },
    });

    it('raises one operations escalation and opens its item', async () => {
      const db = tx(null);
      const { fire, effects, runs } = setup({ status: 'in_progress' }, db);

      await fire('T15.escalate');

      expect(runs[0].result).toEqual({ changed: true });
      expect(db.requestEscalation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          requestId: 'request-1',
          target: 'operations',
          source: 'system',
          raisedAt: now,
        }) as unknown,
      });
      expect(effects.approvalOpens).toEqual([
        { kind: 'escalation', itemId: 'esc-1' },
      ]);
      expect(effects.audit).toHaveLength(1);
    });

    it.each([
      ['one is already open', { status: 'in_progress' }, { id: 'esc-0' }],
      ['the job is no longer in progress', { status: 'closed' }, null],
    ])('does nothing when %s', async (_name, snap, existing) => {
      const db = tx(existing);
      const { fire, effects, runs } = setup(snap, db);

      await fire('T15.escalate');

      expect(runs[0].result).toEqual({ changed: false });
      expect(db.requestEscalation.create).not.toHaveBeenCalled();
      expect(effects.approvalOpens).toEqual([]);
    });
  });

  it('T16.review opens the blocker item for a blocked job', async () => {
    const { fire, effects, runs } = setup({ status: 'blocked' });

    await fire('T16.review');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.approvalOpens).toEqual([
      { kind: 'blocker', itemId: 'request-1' },
    ]);
    expect(effects.notify[0].event).toBe('progress.hold_review');
  });

  it('T16.review does nothing once the job resumed', async () => {
    const { fire, effects, runs } = setup({ status: 'in_progress' });

    await fire('T16.review');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });
});
