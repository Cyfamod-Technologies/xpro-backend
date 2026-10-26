import { cancelOpenScheduleProposals } from './schedule-proposals';

describe('cancelOpenScheduleProposals (D-07)', () => {
  const build = (open: Array<{ id: string }>) => {
    const tx = {
      schedule: {
        findMany: jest.fn().mockResolvedValue(open),
        updateMany: jest.fn(),
      },
    };
    const stops: Array<{ kind: unknown; refId?: string }> = [];
    const timers = {
      start: jest.fn(),
      stop: (kind: unknown, refId?: string) => stops.push({ kind, refId }),
    };
    return { tx, timers, stops };
  };

  it('cancels proposed and changes_requested rows and stops their T11 timers', async () => {
    const { tx, timers, stops } = build([{ id: 's-1' }, { id: 's-2' }]);

    await cancelOpenScheduleProposals({ tx: tx as never, timers }, 'request-1');

    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['proposed', 'changes_requested'] },
      },
      select: { id: true },
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-1', 's-2'] } },
      data: { status: 'cancelled' },
    });
    expect(stops).toEqual([
      { kind: ['T11.reminder24h', 'T11.staff48h'], refId: 's-1' },
      { kind: ['T11.reminder24h', 'T11.staff48h'], refId: 's-2' },
    ]);
  });

  it('writes nothing when there is no open proposal', async () => {
    const { tx, timers, stops } = build([]);

    await cancelOpenScheduleProposals({ tx: tx as never, timers }, 'request-1');

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
  });
});
