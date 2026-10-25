import { TimerKinds } from '../platform/timers/timer-kinds';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from './system-command.testkit';
import { T6TimerHandlers } from './t6-timer-handlers';

const askedAt = new Date('2026-10-01T10:00:00.000Z');

function setup(
  snap: { status?: string; intake?: { state: string } } = {},
  row: { clarificationAskedAt: Date | null } = {
    clarificationAskedAt: askedAt,
  },
) {
  const tx = {
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn(),
    },
    cancellation: { create: jest.fn().mockResolvedValue({ id: 'cancel-1' }) },
    requestMessage: { create: jest.fn() },
  };
  const kit = systemCommandKit({
    tx,
    snap: {
      status: 'submitted',
      intake: { state: 'clarification' },
      ...snap,
    } as never,
  });
  const registry = new TimerRegistry();
  new T6TimerHandlers(registry, kit.runner);
  const fire = (kind: string, payload: unknown = null) =>
    registry.get(kind)?.(
      timerFixture(kind, { payload: payload as never }),
    ) as Promise<void>;
  return { tx, fire, ...kit };
}

const current = { clarificationAskedAt: askedAt.toISOString() };

describe('T6 clarification timer handlers', () => {
  it('auto-cancels the still-current clarification through the runner', async () => {
    const { tx, fire, effects, runs } = setup();

    await fire(TimerKinds.T6AutoCancel, current);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      command: 'timer.T6.autoCancel',
      requestRef: 'request-1',
      result: { changed: true },
    });
    expect(tx.cancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'request-1',
        requestedBy: 'system',
        reasonCode: 'no_response',
        status: 'completed',
        stage: 'submitted',
      }) as unknown,
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelled', cancellationId: 'cancel-1' },
    });
    expect(tx.requestMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: "Cancelled: we didn't hear back from you.",
      }) as unknown,
    });
    expect(effects.audit.map((entry) => entry.action)).toEqual([
      'Request cancelled (no response)',
    ]);
    expect(effects.notify).toEqual([
      {
        event: 'request.auto_cancelled',
        params: { requestCode: 'XPR-00042' },
      },
    ]);
    expect(effects.timerStops[0].kind).toEqual([
      TimerKinds.T6Reminder48h,
      TimerKinds.T6Staff5d,
      TimerKinds.T6FinalWarning,
      TimerKinds.T6AutoCancel,
    ]);
    expect(effects.approvalCloses.map(({ kind }) => kind)).toEqual([
      'intake',
      'clarification_overdue',
    ]);
  });

  it('does nothing when the clarification was answered before the timer ran', async () => {
    const { tx, fire, effects, runs } = setup({
      intake: { state: 'approved' },
    });

    await fire(TimerKinds.T6AutoCancel, current);

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.cancellation.create).not.toHaveBeenCalled();
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(tx.requestMessage.create).not.toHaveBeenCalled();
    expect(effects.notify).toEqual([]);
    expect(effects.audit).toEqual([]);
  });

  it('does nothing when a newer clarification replaced the one the timer was set for', async () => {
    const { tx, fire, runs } = setup(
      {},
      { clarificationAskedAt: new Date('2026-10-05T10:00:00.000Z') },
    );

    await fire(TimerKinds.T6AutoCancel, current);

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.cancellation.create).not.toHaveBeenCalled();
  });

  it('skips the runner for a timer without a clarification marker', async () => {
    const { fire, runs } = setup();

    await fire(TimerKinds.T6AutoCancel, null);

    expect(runs).toEqual([]);
  });

  it.each([
    [TimerKinds.T6Reminder48h, 'request.clarification_reminder'],
    [TimerKinds.T6Staff5d, 'request.clarification_overdue'],
    [TimerKinds.T6FinalWarning, 'request.clarification_final_warning'],
  ])('%s notifies without bumping the version', async (kind, event) => {
    const { fire, effects, runs } = setup();

    await fire(kind, current);

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.notify).toEqual([
      { event, params: { requestCode: 'XPR-00042' } },
    ]);
  });

  it('a reminder for an answered clarification reports no change', async () => {
    const { fire, effects, runs } = setup({ intake: { state: 'approved' } });

    await fire(TimerKinds.T6Reminder48h, current);

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });
  it('opens the clarification_overdue staff item when the day-5 timer fires, not before (A-13)', async () => {
    const { fire, effects } = setup();

    await fire(TimerKinds.T6Reminder48h, current);
    await fire(TimerKinds.T6FinalWarning, current);
    expect(effects.approvalOpens).toEqual([]);

    await fire(TimerKinds.T6Staff5d, current);
    expect(effects.approvalOpens).toEqual([
      { kind: 'clarification_overdue', itemId: 'request-1' },
    ]);
  });

  it('opens no staff item when the clarification was already answered (A-13)', async () => {
    const { fire, effects, runs } = setup({ intake: { state: 'approved' } });

    await fire(TimerKinds.T6Staff5d, current);

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.approvalOpens).toEqual([]);
  });

  it('words the auto-cancel note with the configured number of days (A-12)', async () => {
    const kit = setup();
    kit.ctx.settings = { 'clarification.autoCancelDays': 7 };

    await kit.fire(TimerKinds.T6AutoCancel, current);

    expect(kit.tx.cancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        note: 'No response to the clarification request within 7 days.',
      }) as unknown,
    });
  });
});
