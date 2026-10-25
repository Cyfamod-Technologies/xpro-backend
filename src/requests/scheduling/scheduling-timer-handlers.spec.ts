import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { SchedulingTimerHandlers } from './scheduling-timer-handlers';

function setup(status: string, tx: Record<string, unknown>) {
  const kit = systemCommandKit({ tx, snap: { status } as never });
  const registry = new TimerRegistry();
  new SchedulingTimerHandlers(registry, kit.runner);
  const fire = (kind: string) =>
    registry.get(kind)?.(
      timerFixture(kind, {
        refId: 'schedule-1',
        dueAt: new Date('2026-10-25T08:00:00.000Z'),
      }),
    ) as Promise<void>;
  return { fire, ...kit };
}

const scheduleTx = (schedule: unknown) => ({
  schedule: { findFirst: jest.fn().mockResolvedValue(schedule) },
});

describe('T11 and T12 schedule timers', () => {
  it.each([
    ['T11.reminder24h', 'schedule.reminder'],
    ['T12.reminder24h', 'schedule.prestart24h'],
    ['T12.reminder2h', 'schedule.prestart2h'],
  ])(
    '%s notifies for a live schedule without a version bump',
    async (kind, event) => {
      const { fire, effects, runs } = setup(
        'scheduled',
        scheduleTx({ id: 'schedule-1' }),
      );

      await fire(kind);

      expect(runs[0].opts).toEqual({ bumpVersion: false });
      expect(effects.notify).toEqual([
        { event, params: { requestCode: 'XPR-00042' } },
      ]);
    },
  );

  it('does not remind about a schedule that is cancelled or superseded', async () => {
    const { fire, effects, runs } = setup('scheduled', scheduleTx(null));

    await fire('T12.reminder2h');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });

  it('T11.staff48h opens the schedule-change item for a still-proposed schedule', async () => {
    const { fire, effects, runs } = setup(
      'matched',
      scheduleTx({ id: 'schedule-1' }),
    );

    await fire('T11.staff48h');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.approvalOpens).toEqual([
      { kind: 'schedule_change', itemId: 'schedule-1' },
    ]);
    expect(effects.notify[0].event).toBe('schedule.staff_followup');
    expect(effects.audit).toHaveLength(1);
  });

  it('T11.staff48h does nothing once the proposal was answered', async () => {
    const { fire, effects, runs } = setup('matched', scheduleTx(null));

    await fire('T11.staff48h');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.approvalOpens).toEqual([]);
  });
});

describe('T13 no-show check', () => {
  const checkTx = (options: {
    schedule?: unknown;
    approvedStart?: unknown;
    pendingStart?: unknown;
  }) => ({
    schedule: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.schedule === undefined
            ? { id: 'schedule-1', requestId: 'request-1', assignmentId: 'a-1' }
            : options.schedule,
        ),
    },
    progressUpdate: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { state: string } }) =>
          Promise.resolve(
            where.state === 'approved'
              ? (options.approvedStart ?? null)
              : (options.pendingStart ?? null),
          ),
        ),
    },
  });

  it('opens the no-show item and notifies staff when no start was recorded', async () => {
    const { fire, effects, runs } = setup('scheduled', checkTx({}));

    await fire('T13.noShowCheck');

    expect(runs[0].result).toEqual({ changed: true });
    expect(effects.approvalOpens).toEqual([
      { kind: 'no_show', itemId: 'schedule-1' },
    ]);
    expect(effects.notify[0].event).toBe('noshow.investigate');
    expect(effects.audit[0].action).toBe('No-show check opened');
  });

  it('re-arms an hour later while a start update awaits review', async () => {
    const { fire, effects, runs } = setup(
      'scheduled',
      checkTx({ pendingStart: { id: 'u-1' } }),
    );

    await fire('T13.noShowCheck');

    expect(effects.timerStarts).toEqual([
      {
        kind: 'T13.noShowCheck',
        dueAt: new Date('2026-10-25T09:00:00.000Z'),
        refId: 'schedule-1',
        payload: undefined,
      },
    ]);
    expect(effects.approvalOpens).toEqual([]);
    expect(runs[0].result).toEqual({ changed: true });
  });

  it.each([
    ['work already started', 'scheduled', { approvedStart: { id: 'u-1' } }],
    ['the schedule is no longer confirmed', 'scheduled', { schedule: null }],
    ['the request is not scheduled any more', 'in_progress', {}],
  ])('does nothing when %s', async (_name, status, options) => {
    const { fire, effects, runs } = setup(status, checkTx(options));

    await fire('T13.noShowCheck');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.approvalOpens).toEqual([]);
    expect(effects.notify).toEqual([]);
    expect(effects.timerStarts).toEqual([]);
  });
});
