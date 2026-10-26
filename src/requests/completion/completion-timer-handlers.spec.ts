import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { CompletionTimerHandlers } from './completion-timer-handlers';

const now = new Date('2026-10-24T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function setup(
  snap: Record<string, unknown>,
  tx: Record<string, unknown> = {},
) {
  const kit = systemCommandKit({
    now,
    tx,
    snap,
    settings: { 'completion.defectsWindowDays': 7 },
  });
  const finance = { createPrimary: jest.fn() };
  const registry = new TimerRegistry();
  new CompletionTimerHandlers(registry, kit.runner, finance as never);
  const fire = (kind: string) =>
    registry.get(kind)?.(timerFixture(kind)) as Promise<void>;
  return { fire, finance, ...kit };
}

const requestRow = (row: Record<string, unknown>) => ({
  serviceRequest: {
    findUnique: jest.fn().mockResolvedValue(row),
    update: jest.fn(),
  },
});

describe('T17 completion timers', () => {
  it('reminds the customer before the confirmation deadline without a version bump', async () => {
    const tx = requestRow({ confirmDueAt: new Date(now.getTime() + day) });
    const { fire, effects, runs } = setup({ status: 'completion_pending' }, tx);

    await fire('T17.reminder24h');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.notify[0].event).toBe('completion.reminder');
  });

  it.each([
    [
      'the job was confirmed',
      { status: 'acknowledged' },
      { confirmDueAt: new Date(now.getTime() + day) },
    ],
    [
      'the deadline passed',
      { status: 'completion_pending' },
      { confirmDueAt: new Date(now.getTime() - day) },
    ],
  ])('does not remind when %s', async (_name, snap, row) => {
    const { fire, effects, runs } = setup(snap, requestRow(row));

    await fire('T17.reminder48h');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });

  describe('T17.autoConfirm', () => {
    const confirmTx = (
      row: Record<string, unknown>,
      payoutAssignmentId = 'a-1',
    ) => ({
      ...requestRow(row),
      assignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'a-1', providerId: 'provider-1' }),
      },
      quote: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ payoutAmount: 90_000n, payoutAssignmentId }),
      },
    });
    const due = {
      confirmDueAt: new Date(now.getTime() - day),
      cancellationId: null,
    };

    it('acknowledges the job, creates the payout and records the effects through the runner', async () => {
      const tx = confirmTx(due);
      const { fire, finance, effects, runs } = setup(
        { status: 'completion_pending' },
        tx,
      );

      await fire('T17.autoConfirm');

      expect(runs[0]).toMatchObject({
        command: 'timer.T17.autoConfirm',
        result: { changed: true },
      });
      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-1' },
        data: expect.objectContaining({
          status: 'acknowledged',
          acknowledgedBy: 'system',
          defectsWindowEndsAt: new Date(now.getTime() + 7 * day),
        }) as unknown,
      });
      expect(
        (
          tx.serviceRequest.update.mock.calls[0] as [
            { data: Record<string, unknown> },
          ]
        )[0].data,
      ).not.toHaveProperty('version');
      expect(finance.createPrimary).toHaveBeenCalledWith(
        expect.objectContaining({ tx }),
        {
          requestId: 'request-1',
          assignmentId: 'a-1',
          providerId: 'provider-1',
          amount: 90_000n,
          payoutAssignmentId: 'a-1',
        },
      );
      expect(effects.timerStops[0].kind).toEqual([
        'T17.reminder24h',
        'T17.reminder48h',
        'T17.autoConfirm',
      ]);
      expect(effects.timerStarts).toEqual([
        {
          kind: 'T21.defectsEnd',
          dueAt: new Date(now.getTime() + 7 * day),
          refId: undefined,
          payload: undefined,
        },
      ]);
      expect(effects.approvalOpens).toEqual([]);
      expect(effects.audit[0].action).toBe('Completion auto-confirmed');
      expect(effects.notify[0].event).toBe('completion.auto_confirmed');
    });

    it.each([
      [
        'the job is on hold',
        { status: 'completion_pending', hold: { kind: 'staff' } },
        due,
        'a-1',
      ],
      [
        'an issue is open',
        { status: 'completion_pending', openIssues: [{ status: 'open' }] },
        due,
        'a-1',
      ],
      [
        'the deadline has not passed',
        { status: 'completion_pending' },
        { ...due, confirmDueAt: new Date(now.getTime() + day) },
        'a-1',
      ],
      [
        'a cancellation request is pending',
        {
          status: 'completion_pending',
          pendingCancellation: true,
          pendingCancellationInfo: { id: 'c-1', status: 'pending' },
        },
        due,
        'a-1',
      ],
      [
        'a cancellation was approved',
        { status: 'completion_pending' },
        { ...due, cancellationId: 'c-1' },
        'a-1',
      ],
      [
        'the customer already confirmed',
        { status: 'acknowledged' },
        due,
        'a-1',
      ],
      [
        'the payout was quoted for another assignment',
        { status: 'completion_pending' },
        due,
        'a-2',
      ],
    ])('does nothing when %s', async (_name, snap, row, payoutAssignmentId) => {
      const tx = confirmTx(row, payoutAssignmentId);
      const { fire, finance, effects, runs } = setup(snap, tx);

      await fire('T17.autoConfirm');

      expect(runs[0].result).toEqual({ changed: false });
      expect(tx.serviceRequest.update).not.toHaveBeenCalled();
      expect(finance.createPrimary).not.toHaveBeenCalled();
      expect(effects.notify).toEqual([]);
      expect(effects.timerStops).toEqual([]);
      expect(effects.timerStarts).toEqual([]);
      expect(effects.approvalOpens).toEqual([]);
    });
  });

  describe('T21.defectsEnd', () => {
    it('opens the ready-to-close item once the window has ended', async () => {
      const { fire, effects, runs } = setup({
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(now.getTime() - day),
      });

      await fire('T21.defectsEnd');

      expect(runs[0].opts).toEqual({ bumpVersion: false });
      expect(effects.approvalOpens).toEqual([
        { kind: 'ready_to_close', itemId: 'request-1' },
      ]);
    });

    it.each([
      [
        'the window is still open',
        {
          status: 'acknowledged',
          defectsWindowEndsAt: new Date(now.getTime() + day),
        },
      ],
      [
        'the job already closed',
        {
          status: 'closed',
          defectsWindowEndsAt: new Date(now.getTime() - day),
        },
      ],
      [
        'no window was set',
        { status: 'acknowledged', defectsWindowEndsAt: null },
      ],
    ])('does nothing when %s', async (_name, snap) => {
      const { fire, effects, runs } = setup(snap);

      await fire('T21.defectsEnd');

      expect(runs[0].result).toEqual({ changed: false });
      expect(effects.approvalOpens).toEqual([]);
    });
  });
});
