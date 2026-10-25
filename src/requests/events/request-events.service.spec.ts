import { SYSTEM_ACTOR } from '../../platform/actor/actor.types';
import { systemCommandKit } from '../system-command.testkit';
import { RequestEventsService } from './request-events.service';

function build(
  options: {
    snap?: Record<string, unknown>;
    tx?: Record<string, unknown>;
    prisma?: Record<string, unknown>;
  } = {},
) {
  const kit = systemCommandKit({
    tx: options.tx,
    snap: options.snap as never,
  });
  const prisma = options.prisma ?? {};
  const service = new RequestEventsService(prisma as never, kit.runner);
  return { service, prisma, ...kit };
}

describe('RequestEventsService.onPaymentSettled', () => {
  const paymentTx = (
    request: { lateRefundOpened?: boolean; quoteStatus?: string } = {},
  ) => ({
    payment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'payment-1',
        amount: 500_000n,
        reference: 'xpro_ref_1',
        lateRefundOpened: request.lateRefundOpened ?? false,
      }),
      update: jest.fn(),
    },
    quote: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'quote-1',
        status: request.quoteStatus ?? 'accepted',
      }),
    },
    refund: { create: jest.fn() },
    serviceRequest: { update: jest.fn() },
  });
  const outer = { outer: true } as never;

  it('moves an awaiting-payment request to ready_to_schedule through the caller transaction', async () => {
    const tx = paymentTx();
    const { service, runner, effects, runs } = build({
      tx,
      snap: { status: 'awaiting_payment' },
    });
    const runInTx = jest.spyOn(runner, 'runInTx');

    const result = await service.onPaymentSettled(
      outer,
      'request-1',
      'quote-1',
      'payment-1',
    );

    expect(runInTx).toHaveBeenCalledWith(
      outer,
      expect.objectContaining({
        command: 'payment.settled',
        actor: SYSTEM_ACTOR,
        requestRef: 'request-1',
      }),
      expect.any(Function),
    );
    expect(result.settled).toBe(true);
    expect(runs[0].result).toEqual({ changed: true });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'ready_to_schedule' },
    });
    expect(effects.timerStops).toEqual([
      {
        kind: ['T9.reminder24h', 'T9.reminder72h', 'T9.lapse'],
        refId: 'quote-1',
      },
      { kind: 'payment.pendingCheck', refId: 'payment-1' },
    ]);
    expect(effects.audit[0].action).toBe('Request paid');
    expect(effects.notify.map((entry) => entry.event)).toEqual([
      'payment.settled_customer',
      'payment.settled_provider',
      'payment.settled_staff',
    ]);
    expect(effects.approvalOpens).toEqual([
      { kind: 'schedule_needed', itemId: 'request-1' },
    ]);
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it('opens one full refund and leaves the request alone for a late payment', async () => {
    const tx = paymentTx();
    const { service, effects } = build({ tx, snap: { status: 'matched' } });

    const result = await service.onPaymentSettled(
      outer,
      'request-1',
      'quote-1',
      'payment-1',
    );

    expect(result.settled).toBe(false);
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(tx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-1',
        amount: 500_000n,
        status: 'pending_approval',
        requestedBy: 'system',
      }) as unknown,
    });
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: { lateRefundOpened: true },
    });
    expect(effects.notify).toEqual([
      {
        event: 'payment.late',
        params: { requestCode: 'XPR-00042', reference: 'xpro_ref_1' },
      },
    ]);
    expect(effects.approvalOpens).toEqual([]);
  });

  it('does not open a second refund when the late refund already exists', async () => {
    const tx = paymentTx({ lateRefundOpened: true });
    const { service } = build({ tx, snap: { status: 'matched' } });

    await service.onPaymentSettled(outer, 'request-1', 'quote-1', 'payment-1');

    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it('treats a request whose quote is no longer accepted as late', async () => {
    const tx = paymentTx({ quoteStatus: 'expired' });
    const { service } = build({ tx, snap: { status: 'awaiting_payment' } });

    const result = await service.onPaymentSettled(
      outer,
      'request-1',
      'quote-1',
      'payment-1',
    );

    expect(result.settled).toBe(false);
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
  });
});

describe('RequestEventsService.onRefundsResolved', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 10, minute));
  const settled = [
    { paymentId: 'payment-1', status: 'completed', createdAt: at(0) },
  ];
  const refundTx = (
    refunds: Array<{ paymentId: string; status: string; createdAt: Date }>,
    cancellation: unknown = { requestId: 'request-1' },
    accepted: Array<{ id: string; providerUserId: string }> = [],
    openItems: Array<{ kind: string; itemId: string }> = [],
  ) => ({
    cancellation: {
      findUnique: jest.fn().mockResolvedValue(cancellation),
      updateMany: jest.fn(),
    },
    refund: { findMany: jest.fn().mockResolvedValue(refunds) },
    serviceRequest: { update: jest.fn() },
    assignment: {
      findMany: jest.fn().mockResolvedValue(accepted),
      updateMany: jest.fn(),
    },
    approvalDeadline: { findMany: jest.fn().mockResolvedValue(openItems) },
  });

  it('completes the cancellation and cancels a cancelling request once every refund is resolved', async () => {
    const tx = refundTx(settled);
    const { service, effects, runs } = build({
      tx,
      snap: { status: 'cancelling' },
    });

    const result = await service.onRefundsResolved(
      tx as never,
      'cancellation-1',
    );

    expect(result.resolved).toBe(true);
    expect(runs[0]).toMatchObject({
      command: 'refunds.resolved',
      requestRef: 'request-1',
    });
    expect(tx.cancellation.updateMany).toHaveBeenCalledWith({
      where: { id: 'cancellation-1', status: 'approved' },
      data: { status: 'completed' },
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelled' },
    });
    expect(effects.audit[0].action).toBe(
      'Request cancelled (refunds resolved)',
    );
  });

  it('on cancelled tells the customer and the provider, ends the accepted assignment and closes every open approval item', async () => {
    const tx = refundTx(
      settled,
      { requestId: 'request-1' },
      [{ id: 'assignment-1', providerUserId: 'provider-user-1' }],
      [
        { kind: 'refund', itemId: 'refund-1' },
        { kind: 'schedule_needed', itemId: 'request-1' },
      ],
    );
    const { service, effects } = build({ tx, snap: { status: 'cancelling' } });

    await service.onRefundsResolved(tx as never, 'cancellation-1');

    const [ended] = tx.assignment.updateMany.mock.calls[0] as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(ended.where).toEqual({
      id: { in: ['assignment-1'] },
      status: 'accepted',
    });
    expect(ended.data).toMatchObject({
      status: 'withdrawn',
      endReason: 'request_cancelled',
    });
    // The assignment keeps its workStarted flag for compensation (05 §6.4).
    expect(ended.data).not.toHaveProperty('workStarted');
    expect(effects.notify).toEqual([
      {
        event: 'cancellation.completed_customer',
        params: { requestCode: 'XPR-00042' },
      },
      {
        event: 'cancellation.completed_provider',
        params: {
          requestCode: 'XPR-00042',
          assignmentId: 'assignment-1',
          providerUserId: 'provider-user-1',
        },
      },
    ]);
    expect(effects.approvalCloses).toEqual([
      { kind: 'refund', itemId: 'refund-1', reason: 'request_cancelled' },
      {
        kind: 'schedule_needed',
        itemId: 'request-1',
        reason: 'request_cancelled',
      },
    ]);
  });

  it('waits while any refund is unresolved', async () => {
    for (const status of [
      'pending_approval',
      'awaiting_second_approval',
      'approved',
      'processing',
      'rejected',
      'failed',
    ]) {
      const tx = refundTx([
        { paymentId: 'payment-1', status: 'completed', createdAt: at(0) },
        { paymentId: 'payment-2', status, createdAt: at(1) },
      ]);
      const { service, runs } = build({ tx, snap: { status: 'cancelling' } });

      const result = await service.onRefundsResolved(
        tx as never,
        'cancellation-1',
      );

      expect(result.resolved).toBe(false);
      expect(runs).toEqual([]);
      expect(tx.cancellation.updateMany).not.toHaveBeenCalled();
    }
  });

  it('resolves once a rejected refund has been replaced by one that completed', async () => {
    const tx = refundTx([
      { paymentId: 'payment-1', status: 'rejected', createdAt: at(0) },
      { paymentId: 'payment-1', status: 'completed', createdAt: at(5) },
    ]);
    const { service } = build({ tx, snap: { status: 'cancelling' } });

    const result = await service.onRefundsResolved(
      tx as never,
      'cancellation-1',
    );

    expect(result.resolved).toBe(true);
  });

  it('completes the cancellation but leaves a request that is not cancelling', async () => {
    const tx = refundTx(settled);
    const { service, runs, effects } = build({
      tx,
      snap: { status: 'cancelled' },
    });

    const result = await service.onRefundsResolved(
      tx as never,
      'cancellation-1',
    );

    expect(result.resolved).toBe(false);
    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.cancellation.updateMany).toHaveBeenCalled();
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(tx.assignment.updateMany).not.toHaveBeenCalled();
    expect(effects.notify).toEqual([]);
  });

  it('ignores an unknown cancellation', async () => {
    const tx = refundTx(settled, null);
    const { service, runs } = build({ tx });

    const result = await service.onRefundsResolved(tx as never, 'missing');

    expect(result.resolved).toBe(false);
    expect(runs).toEqual([]);
  });
});

describe('RequestEventsService provider events', () => {
  it('withdraws open offers, restarts dispatch in auto mode and holds payouts for accepted jobs', async () => {
    const tx = {
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'offer-1', request: { dispatchMode: 'auto' } },
          ]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      serviceRequest: { update: jest.fn() },
      payout: { updateMany: jest.fn() },
    };
    const prisma = {
      providerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'provider-1' }),
      },
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ requestId: 'request-1' }])
          .mockResolvedValueOnce([{ id: 'job-1', requestId: 'request-2' }]),
      },
      auditLog: { create: jest.fn() },
    };
    const { service, effects, runs } = build({ tx, prisma });
    // The offers pass finds no other live assignment; the accepted-job pass finds its own.
    tx.assignment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-1' });

    await service.onProviderStandingChanged('provider-1', 'Suspended.');

    expect(runs.map((run) => run.command)).toEqual([
      'provider.standingChanged',
      'provider.standingChanged',
    ]);
    expect(runs[0].requestRef).toBe('request-1');
    expect(tx.assignment.update).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: expect.objectContaining({
        status: 'withdrawn',
        endReason: 'provider_suspended',
      }) as unknown,
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'under_review', needsAssignmentReason: null },
    });
    expect(effects.timerStops[0]).toEqual({
      kind: ['T1.reminder', 'T1.expire', 'T3.review'],
      refId: 'offer-1',
    });
    expect(effects.cascades).toEqual(['cascade']);
    expect(runs[1].opts).toBeUndefined();
    expect(tx.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'on_hold',
          holdReason: 'Suspended.',
          holdSource: 'provider_standing',
        },
      }),
    );
    expect(effects.notify.map((entry) => entry.event)).toContain(
      'request.provider_standing_changed',
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'provider_profile',
        metadata: {
          reason: 'Suspended.',
          affectedRequestIds: ['request-1', 'request-2'],
        },
      }) as unknown,
    });
  });

  it('asks staff to assign when the request is in manual mode', async () => {
    const tx = {
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'offer-1', request: { dispatchMode: 'manual' } },
          ]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      serviceRequest: { update: jest.fn() },
    };
    const prisma = {
      providerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'provider-1' }),
      },
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ requestId: 'request-1' }])
          .mockResolvedValueOnce([]),
      },
      auditLog: { create: jest.fn() },
    };
    const { service, effects } = build({ tx, prisma });

    await service.onProviderStandingChanged('provider-1', 'Delisted.');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        status: 'under_review',
        needsAssignmentReason: 'provider_suspended',
      },
    });
    expect(effects.notify.map((entry) => entry.event)).toEqual([
      'request.needs_manual_assignment',
    ]);
    expect(effects.cascades).toEqual([]);
  });

  it('does nothing for an unknown provider', async () => {
    const prisma = {
      providerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const { service, runs } = build({ prisma });

    await service.onProviderStandingChanged('missing', 'Suspended.');

    expect(runs).toEqual([]);
  });

  describe('onProviderUnavailable (03 §6.3)', () => {
    const unavailableTx = (mode: 'auto' | 'manual') => ({
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'offer-1', request: { dispatchMode: mode } },
          ]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      serviceRequest: { update: jest.fn() },
      payout: { updateMany: jest.fn() },
    });
    const unavailablePrisma = () => ({
      assignment: {
        findMany: jest.fn().mockResolvedValue([{ requestId: 'request-1' }]),
      },
      auditLog: { create: jest.fn() },
    });

    it('withdraws only offered offers, sends the request back to dispatch and audits it per request', async () => {
      const tx = unavailableTx('auto');
      const prisma = unavailablePrisma();
      const { service, effects, runs } = build({ tx, prisma });

      await service.onProviderUnavailable('provider-1');

      expect(prisma.assignment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.assignment.findMany).toHaveBeenCalledWith({
        where: { providerId: 'provider-1', status: { in: ['offered'] } },
        select: { requestId: true },
      });
      expect(tx.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ['offered'] },
          }) as unknown,
        }),
      );
      expect(runs.map((run) => run.requestRef)).toEqual(['request-1']);
      expect(tx.assignment.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: expect.objectContaining({
          status: 'withdrawn',
          response: 'Provider turned availability off.',
        }) as unknown,
      });
      expect(effects.cascades).toEqual(['cascade']);
      expect(effects.audit).toEqual([
        {
          action: 'Provider offer withdrawn (availability off)',
          data: {
            changes: {
              providerId: 'provider-1',
              reason: 'Provider turned availability off.',
            },
          },
        },
      ]);
    });

    it('never holds payouts, flags accepted jobs or writes a provider-level standing audit', async () => {
      const tx = unavailableTx('auto');
      const prisma = unavailablePrisma();
      const { service, effects } = build({ tx, prisma });

      await service.onProviderUnavailable('provider-1');

      expect(tx.payout.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(effects.notify.map((entry) => entry.event)).not.toContain(
        'request.provider_standing_changed',
      );
    });

    it('asks staff to assign in manual mode', async () => {
      const tx = unavailableTx('manual');
      const { service, effects } = build({ tx, prisma: unavailablePrisma() });

      await service.onProviderUnavailable('provider-1');

      expect(effects.cascades).toEqual([]);
      expect(effects.notify.map((entry) => entry.event)).toEqual([
        'request.needs_manual_assignment',
      ]);
    });

    it('does nothing when the provider has no offered offers', async () => {
      const prisma = {
        assignment: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const { service, runs } = build({ prisma });

      await service.onProviderUnavailable('provider-1');

      expect(runs).toEqual([]);
    });
  });
});

describe('RequestEventsService.onProviderHoursChanged', () => {
  const scheduleTx = (schedule: unknown) => ({
    schedule: {
      findFirst: jest.fn().mockResolvedValue(schedule),
      update: jest.fn(),
    },
  });

  it('sets a still-proposed schedule to changes_requested', async () => {
    const tx = scheduleTx({ id: 'schedule-1' });
    const { service, effects, runs } = build({ tx });

    await service.onProviderHoursChanged('provider-1', [
      { scheduleId: 'schedule-1', requestId: 'request-1' },
    ]);

    expect(runs[0]).toMatchObject({
      command: 'provider.hoursChanged',
      requestRef: 'request-1',
      result: { changed: true },
    });
    expect(tx.schedule.update).toHaveBeenCalledWith({
      where: { id: 'schedule-1' },
      data: {
        status: 'changes_requested',
        responses: { push: 'Provider: working hours changed' },
      },
    });
    expect(effects.audit).toHaveLength(1);
  });

  it('skips a schedule that was answered in the meantime', async () => {
    const tx = scheduleTx(null);
    const { service, runs } = build({ tx });

    await service.onProviderHoursChanged('provider-1', [
      { scheduleId: 'schedule-1', requestId: 'request-1' },
    ]);

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.schedule.update).not.toHaveBeenCalled();
  });
});
