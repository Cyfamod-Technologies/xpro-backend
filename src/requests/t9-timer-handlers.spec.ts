import { TimerRegistry } from '../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from './system-command.testkit';
import { T9TimerHandlers } from './t9-timer-handlers';

const now = new Date('2026-10-24T12:00:00.000Z');
const hour = 60 * 60 * 1000;

const minutes = 60 * 1000;

function setup(
  snapStatus: string,
  quote: { paymentDueAt: Date | null; total?: bigint } | null,
  pendingAttemptAgeMinutes: number | null = null,
) {
  const tx = {
    quote: {
      findFirst: jest.fn().mockResolvedValue(
        quote && {
          id: 'quote-1',
          requestId: 'request-1',
          total: 150_000_00n,
          ...quote,
        },
      ),
      update: jest.fn(),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue(
        pendingAttemptAgeMinutes === null
          ? []
          : [
              {
                status: 'pending',
                method: 'paystack',
                createdAt: new Date(
                  now.getTime() - pendingAttemptAgeMinutes * minutes,
                ),
              },
            ],
      ),
      findFirst: jest.fn().mockResolvedValue({ id: 'payment-1' }),
    },
    serviceRequest: { update: jest.fn() },
  };
  const prisma = {
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const payments = { recheckPending: jest.fn().mockResolvedValue(null) };
  const kit = systemCommandKit({
    tx,
    now,
    snap: { status: snapStatus } as never,
  });
  const registry = new TimerRegistry();
  new T9TimerHandlers(registry, prisma as never, kit.runner, payments as never);
  const fire = (kind: string, payload: unknown = null) =>
    registry.get(kind)?.(
      timerFixture(kind, { refId: 'quote-1', payload: payload as never }),
    ) as Promise<void>;
  return { tx, prisma, payments, fire, registry, ...kit };
}

describe('T9 payment timer handlers', () => {
  it('reminds while the accepted quote is still awaiting payment, without a version bump', async () => {
    const { fire, effects, runs } = setup('awaiting_payment', {
      paymentDueAt: new Date(now.getTime() + 24 * hour),
    });

    await fire('T9.reminder24h');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.notify[0]).toMatchObject({
      event: 'payment.reminder',
      params: {
        requestCode: 'XPR-00042',
        amount: 150_000_00,
      },
    });
  });

  it('does not remind once the request is no longer awaiting payment', async () => {
    const { fire, effects, runs } = setup('ready_to_schedule', {
      paymentDueAt: new Date(now.getTime() + 24 * hour),
    });

    await fire('T9.reminder72h');

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });

  it('lapses an overdue quote: quote expired, request matched, audit and notice', async () => {
    const { tx, fire, effects, runs } = setup('awaiting_payment', {
      paymentDueAt: new Date(now.getTime() - hour),
    });

    await fire('T9.lapse');

    expect(runs[0]).toMatchObject({
      command: 'timer.T9.lapse',
      result: { changed: true },
    });
    expect(tx.quote.update).toHaveBeenCalledWith({
      where: { id: 'quote-1' },
      data: { status: 'expired' },
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'matched' },
    });
    expect(effects.audit[0].action).toBe('Payment window lapsed');
    expect(effects.notify[0].event).toBe('payment.lapsed');
    expect(effects.approvalOpens).toEqual([
      { kind: 'payment_lapsed', itemId: 'quote-1' },
    ]);
  });

  it('does nothing when payment is not yet due', async () => {
    const { tx, fire, effects, runs } = setup('awaiting_payment', {
      paymentDueAt: new Date(now.getTime() + hour),
    });

    await fire('T9.lapse');

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.quote.update).not.toHaveBeenCalled();
    expect(effects.notify).toEqual([]);
  });

  it('does nothing when the request already moved on', async () => {
    const { tx, fire, runs } = setup('ready_to_schedule', {
      paymentDueAt: new Date(now.getTime() - hour),
    });

    await fire('T9.lapse');

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('defers the lapse 30 minutes while a pending attempt is younger than 30 minutes', async () => {
    const { tx, fire, effects, runs } = setup(
      'awaiting_payment',
      { paymentDueAt: new Date(now.getTime() - hour) },
      10,
    );

    await fire('T9.lapse');

    expect(effects.timerStarts).toEqual([
      {
        kind: 'T9.lapse',
        dueAt: new Date(now.getTime() + 30 * minutes),
        refId: 'quote-1',
        payload: undefined,
      },
    ]);
    expect(tx.quote.update).not.toHaveBeenCalled();
    expect(effects.approvalOpens).toEqual([]);
    expect(runs[0].result).toEqual({ changed: true });
  });

  it('lapses when the pending attempt is 30 minutes old or more', async () => {
    const { tx, fire, effects } = setup(
      'awaiting_payment',
      { paymentDueAt: new Date(now.getTime() - hour) },
      30,
    );

    await fire('T9.lapse');

    expect(tx.quote.update).toHaveBeenCalled();
    expect(effects.timerStarts).toEqual([]);
  });

  it('skips the lapse when the gateway reports the payment settled', async () => {
    const { prisma, payments, fire, runs } = setup('awaiting_payment', {
      paymentDueAt: new Date(now.getTime() - hour),
    });
    prisma.payment.findFirst.mockResolvedValue({ id: 'payment-1' });
    payments.recheckPending.mockResolvedValue('settled');

    await fire('T9.lapse');

    expect(runs).toEqual([]);
  });

  it('still lapses when the recheck leaves the attempt pending', async () => {
    const { prisma, payments, tx, fire } = setup('awaiting_payment', {
      paymentDueAt: new Date(now.getTime() - hour),
    });
    prisma.payment.findFirst.mockResolvedValue({ id: 'payment-1' });
    payments.recheckPending.mockResolvedValue('pending');

    await fire('T9.lapse');

    expect(tx.quote.update).toHaveBeenCalled();
  });

  describe('payment.pendingCheck', () => {
    const fireCheck = (ctx: ReturnType<typeof setup>) =>
      ctx.registry.get('payment.pendingCheck')?.(
        timerFixture('payment.pendingCheck', { refId: 'payment-1' }),
      ) as Promise<void>;

    it('asks the gateway about the attempt and stops when it is decided', async () => {
      const ctx = setup('awaiting_payment', null);
      ctx.payments.recheckPending.mockResolvedValue('failed');

      await fireCheck(ctx);

      expect(ctx.payments.recheckPending).toHaveBeenCalledWith('payment-1');
      expect(ctx.runs).toEqual([]);
    });

    it('checks again in 30 minutes while the gateway has not decided', async () => {
      const ctx = setup('awaiting_payment', null);
      ctx.payments.recheckPending.mockResolvedValue('pending');

      await fireCheck(ctx);

      expect(ctx.effects.timerStarts).toEqual([
        {
          kind: 'payment.pendingCheck',
          dueAt: new Date(now.getTime() + 30 * minutes),
          refId: 'payment-1',
          payload: undefined,
        },
      ]);
    });

    it('does not re-arm once the request left awaiting_payment', async () => {
      const ctx = setup('ready_to_schedule', null);
      ctx.payments.recheckPending.mockResolvedValue('pending');

      await fireCheck(ctx);

      expect(ctx.effects.timerStarts).toEqual([]);
    });
  });
});
