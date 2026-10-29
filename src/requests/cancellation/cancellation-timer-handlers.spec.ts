import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { CancellationTimerHandlers } from './cancellation-timer-handlers';

function setup(snap: Record<string, unknown>) {
  const kit = systemCommandKit({ snap });
  const registry = new TimerRegistry();
  new CancellationTimerHandlers(registry, kit.runner);
  const fire = (refId = 'c-1') =>
    registry.get('T19.followup')?.(
      timerFixture('T19.followup', { refId }),
    ) as Promise<void>;
  return { fire, ...kit };
}

const pending = {
  status: 'quoted',
  pendingCancellation: true,
  pendingCancellationInfo: {
    id: 'c-1',
    status: 'pending',
    requestedBy: 'customer',
    paid: false,
    workStarted: false,
  },
};

describe('T19.followup (D-15)', () => {
  it('is registered on the timer registry', () => {
    const registry = new TimerRegistry();
    new CancellationTimerHandlers(registry, systemCommandKit().runner);

    expect(registry.get('T19.followup')).toBeDefined();
  });

  it('opens the cancellation item and notifies request.cancel holders while the cancellation is pending', async () => {
    const { fire, effects, runs } = setup(pending);

    await fire();

    expect(runs[0]).toMatchObject({
      command: 'timer.T19.followup',
      opts: { bumpVersion: false },
      result: { changed: true },
    });
    expect(effects.approvalOpens).toEqual([
      { kind: 'cancellation', itemId: 'c-1' },
    ]);
    expect(effects.notify).toEqual([
      {
        event: 'cancellation.followup',
        params: { requestCode: 'XPR-00042' },
      },
    ]);
    expect(effects.audit[0].action).toBe('Cancellation follow-up');
  });

  it.each([
    ['the cancellation was decided or withdrawn', { status: 'quoted' }],
    [
      'another cancellation is pending',
      {
        ...pending,
        pendingCancellationInfo: {
          ...pending.pendingCancellationInfo,
          id: 'c-2',
        },
      },
    ],
  ])('does nothing when %s', async (_name, snap) => {
    const { fire, effects, runs } = setup(snap);

    await fire();

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.approvalOpens).toEqual([]);
    expect(effects.notify).toEqual([]);
    expect(effects.audit).toEqual([]);
  });
});
