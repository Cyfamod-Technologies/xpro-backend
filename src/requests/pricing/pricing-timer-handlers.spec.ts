import { renderNotification } from '../../notifications/catalogue';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { PricingTimerHandlers } from './pricing-timer-handlers';

const now = new Date('2026-10-24T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function setup(status: string, tx: Record<string, unknown>) {
  const kit = systemCommandKit({ now, tx, snap: { status } as never });
  const registry = new TimerRegistry();
  new PricingTimerHandlers(registry, kit.runner);
  const fire = (kind: string) =>
    registry.get(kind)?.(
      timerFixture(kind, { refId: 'ref-1' }),
    ) as Promise<void>;
  return { fire, ...kit };
}

describe('T7 costing timers', () => {
  const tx = (assignment: unknown, contribution: unknown) => ({
    assignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
    contribution: { findFirst: jest.fn().mockResolvedValue(contribution) },
  });

  it.each([
    ['T7.reminder24h', 'quote.costing_reminder'],
    ['T7.stall48h', 'quote.stalled'],
  ])(
    '%s notifies while no costing was submitted, without a version bump',
    async (kind, event) => {
      const { fire, effects, runs } = setup('matched', tx({ id: 'a-1' }, null));

      await fire(kind);

      expect(runs[0].opts).toEqual({ bumpVersion: false });
      expect(effects.notify).toEqual([
        { event, params: { requestCode: 'XPR-00042' } },
      ]);
    },
  );

  it.each([
    [
      'the provider already submitted costing',
      'matched',
      { id: 'a-1' },
      { id: 'c-1' },
    ],
    ['the offer is no longer accepted', 'matched', null, null],
    ['the request moved past quoting', 'awaiting_payment', { id: 'a-1' }, null],
  ])(
    'does nothing when %s',
    async (_name, status, assignment, contribution) => {
      const { fire, effects, runs } = setup(
        status,
        tx(assignment, contribution),
      );

      await fire('T7.stall48h');

      expect(runs[0].result).toEqual({ changed: false });
      expect(effects.notify).toEqual([]);
    },
  );
});

describe('T8 quote timers', () => {
  const quoteTx = (validUntil: Date | null, found = true) => ({
    quote: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          found
            ? { id: 'q-1', requestId: 'request-1', version: 3, validUntil }
            : null,
        ),
      update: jest.fn(),
    },
    serviceRequest: { update: jest.fn() },
  });

  it('reminds while the quote is still valid', async () => {
    const { fire, effects, runs } = setup(
      'quoted',
      quoteTx(new Date(now.getTime() + day)),
    );

    await fire('T8.reminder1d');

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.notify[0]).toMatchObject({
      event: 'quote.payment_reminder',
    });
  });

  it('does not remind about an expired or missing quote', async () => {
    const expired = setup('quoted', quoteTx(new Date(now.getTime() - day)));
    await expired.fire('T8.reminder3d');
    const missing = setup('quoted', quoteTx(null, false));
    await missing.fire('T8.reminder3d');

    expect(expired.runs[0].result).toEqual({ changed: false });
    expect(missing.runs[0].result).toEqual({ changed: false });
    expect(expired.effects.notify).toEqual([]);
  });

  it('expires an overdue sent quote and puts the request back to matched', async () => {
    const tx = quoteTx(new Date(now.getTime() - day));
    const { fire, effects, runs } = setup('quoted', tx);

    await fire('T8.expire');

    expect(runs[0].result).toEqual({ changed: true });
    expect(tx.quote.update).toHaveBeenCalledWith({
      where: { id: 'q-1' },
      data: { status: 'expired' },
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'matched' },
    });
    expect(effects.audit[0]).toMatchObject({ action: 'Quote expired' });
    expect(effects.notify).toEqual([
      {
        event: 'quote.expired',
        params: { requestCode: 'XPR-00042', version: 3 },
      },
    ]);
  });

  it('opens the quote_expired item for quote.manage when a quote expires (B-44)', async () => {
    const { fire, effects } = setup(
      'quoted',
      quoteTx(new Date(now.getTime() - day)),
    );

    await fire('T8.expire');

    expect(effects.approvalOpens).toEqual([
      { kind: 'quote_expired', itemId: 'q-1' },
    ]);
  });

  it('renders the spec copy to the customer', () => {
    expect(
      renderNotification('quote.expired', {
        requestCode: 'XPR-00042',
        version: 3,
      }),
    ).toMatchObject({
      title: 'Quote expired',
      message:
        'Quote v3 for XPR-00042 has expired. XPro will send you an updated quote.',
    });
  });

  it.each([
    ['the quote is still valid', 'quoted', new Date(Date.now() + day)],
    [
      'the request already moved on',
      'ready_to_schedule',
      new Date(Date.now() - day),
    ],
  ])('does not expire when %s', async (_name, status, validUntil) => {
    const tx = quoteTx(validUntil);
    const { fire, effects, runs } = setup(status, tx);

    await fire('T8.expire');

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.quote.update).not.toHaveBeenCalled();
    expect(effects.notify).toEqual([]);
    expect(effects.approvalOpens).toEqual([]);
  });
});
