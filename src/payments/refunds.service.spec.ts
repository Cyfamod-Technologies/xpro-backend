import type { ActorContext } from '../platform/actor/actor.types';
import { systemCommandKit } from '../requests/system-command.testkit';
import { GatewayRejectedError } from './payment-gateway';
import { RefundsService } from './refunds.service';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 60 * 60_000);

const staff = (
  userId: string,
  options: { superAdmin?: boolean } = {},
): ActorContext =>
  ({
    userId,
    kind: 'staff',
    displayName: 'Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: [],
      permissions: new Set(['refund.manage']),
      canOwn: false,
      isSuperAdmin: options.superAdmin ?? false,
      permVersion: 1,
    },
  }) as unknown as ActorContext;

const refundRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund-1',
  paymentId: 'payment-1',
  requestId: 'request-1',
  cancellationId: 'cancellation-1',
  amount: 500_000n,
  status: 'pending_approval',
  reason: 'Cancellation refund review.',
  requestedBy: 'finance-1',
  decidedBy: null,
  secondApprover: null,
  transferReference: null,
  transferProofId: null,
  transferRecordedBy: null,
  gatewayRefundId: null,
  reconciledBy: null,
  completedAt: null,
  version: 1,
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
  ...overrides,
});

const paymentRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1',
  requestId: 'request-1',
  amount: 500_000n,
  method: 'paystack',
  status: 'paid',
  reference: 'xpro_abc',
  ...overrides,
});

function build(
  options: {
    refund?: Record<string, unknown>;
    payment?: Record<string, unknown>;
    cancellation?: Record<string, unknown> | null;
    otherRefunds?: Array<{ amount: bigint; status: string }>;
    claim?: number;
    gateway?: Record<string, unknown>;
    listed?: Array<{ id: string; status: string; amount?: number }>;
  } = {},
) {
  const calls: string[] = [];
  const refund = refundRow(options.refund);
  const payment = paymentRow(options.payment);
  const tx = {
    $queryRaw: jest.fn(() => {
      calls.push('lock');
      return Promise.resolve([]);
    }),
    payment: {
      findUnique: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockResolvedValue(payment),
    },
    refund: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { amount: refund.amount } }),
      findUnique: jest.fn().mockResolvedValue(refund),
      findMany: jest.fn().mockResolvedValue(options.otherRefunds ?? []),
      updateMany: jest.fn((_args: unknown) => {
        calls.push('claim');
        return Promise.resolve({ count: options.claim ?? 1 });
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(refundRow({ id: 'refund-new', ...args.data })),
      ),
    },
    cancellation: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.cancellation === undefined
            ? { id: 'cancellation-1', workStarted: false }
            : options.cancellation,
        ),
    },
    serviceRequest: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: 'cancelling', cancellationId: 'c-1' }),
    },
  };
  const kit = systemCommandKit({ tx, now: NOW });
  const prisma = {
    refund: {
      findUnique: jest.fn().mockResolvedValue(refund),
      findUniqueOrThrow: jest.fn().mockResolvedValue(refund),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
  };
  const gateway = {
    refund: jest.fn(() => {
      calls.push('gateway');
      return Promise.resolve({ id: 'gw-1', status: 'pending' });
    }),
    verifyRefund: jest.fn(() => {
      calls.push('verify');
      return Promise.resolve({
        id: 'gw-old',
        status: 'processed',
        amount: 500_000,
      });
    }),
    listRefunds: jest.fn(() => {
      calls.push('list');
      return Promise.resolve(options.listed ?? []);
    }),
    ...options.gateway,
  };
  const requestEvents = {
    onRefundsResolved: jest.fn().mockResolvedValue({
      resolved: true,
      afterCommit: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const uploads = { attach: jest.fn().mockResolvedValue([]) };
  const actors = { resolve: jest.fn() };
  const idempotency = {
    lookup: jest.fn().mockResolvedValue(null),
    store: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RefundsService(
    prisma as never,
    actors as never,
    uploads as never,
    gateway as never,
    kit.runner,
    requestEvents as never,
    idempotency as never,
  );
  return {
    service,
    tx,
    prisma,
    gateway,
    requestEvents,
    uploads,
    actors,
    idempotency,
    calls,
    ...kit,
  };
}

const asStaff = (
  harness: ReturnType<typeof build>,
  userId: string,
  options: { superAdmin?: boolean } = {},
) => harness.actors.resolve.mockResolvedValue(staff(userId, options));

const decideDto = { approve: true, reason: 'Customer cancelled early.' };
const IDEM = { key: 'idem-key-0001', url: '/admin/refunds/refund-1/decide' };

describe('RefundsService.decide', () => {
  it('refuses the requester with the 05 message and writes nothing', async () => {
    const h = build();
    asStaff(h, 'finance-1');

    await expect(
      h.service.decide('finance-1', 'refund-1', decideDto, IDEM),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Another staff member must decide this refund.',
    });
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
  });

  it('locks the payment before it claims the refund (C-09)', async () => {
    const h = build();
    asStaff(h, 'finance-2');
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing' }),
    );

    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);

    expect(h.calls.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('lock')).toBeLessThan(h.calls.indexOf('claim'));
    expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'refund-1', status: 'pending_approval' },
      data: { decidedBy: 'finance-2' },
    });
  });

  it('is a conflict that does nothing when the claim matches no row (C-09)', async () => {
    const h = build({ claim: 0 });
    asStaff(h, 'finance-2');

    await expect(
      h.service.decide('finance-2', 'refund-1', decideDto, IDEM),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This refund is no longer awaiting a decision.',
    });
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
    expect(h.effects.approvalCloses).toEqual([]);
    expect(h.effects.notify).toEqual([]);
  });

  it('does not decide a refund that has already moved on', async () => {
    const h = build({ refund: { status: 'processing' } });
    asStaff(h, 'finance-2');

    await expect(
      h.service.decide('finance-2', 'refund-1', decideDto, IDEM),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('before work: approves the full balance without calling Paystack (C-02, C-08)', async () => {
    const h = build({ otherRefunds: [{ amount: 100_000n, status: 'failed' }] });
    asStaff(h, 'finance-2');
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing' }),
    );

    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);

    expect(h.tx.refund.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'refund-1', status: 'pending_approval' },
      data: {
        amount: 500_000n,
        status: 'approved',
        decidedBy: 'finance-2',
        reason: 'Customer cancelled early.',
        version: { increment: 1 },
      },
    });
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('gateway');
    expect(h.effects.approvalCloses[0]).toMatchObject({
      kind: 'refund',
      itemId: 'refund-1',
    });
    expect(h.effects.audit.map((entry) => entry.action)).toEqual([
      'Refund approved',
    ]);
  });

  it('before work: refuses a partial amount (C-08)', async () => {
    const h = build();
    asStaff(h, 'finance-2');

    await expect(
      h.service.decide(
        'finance-2',
        'refund-1',
        {
          ...decideDto,
          amount: 200_000,
        },
        IDEM,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message:
        'The full refundable balance must be refunded before work starts.',
    });
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an amount above what other refunds leave (C-09: no over-refund)', async () => {
    const h = build({
      refund: { cancellationId: null },
      otherRefunds: [{ amount: 400_000n, status: 'processing' }],
      cancellation: null,
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.decide('finance-2', 'refund-1', decideDto, IDEM),
    ).rejects.toMatchObject({
      status: 422,
      message: 'This refund exceeds the amount available.',
    });
  });

  it('after work: even a zero amount waits for the second approval and nothing is submitted (C-07)', async () => {
    const h = build({
      cancellation: { id: 'cancellation-1', workStarted: true },
    });
    asStaff(h, 'finance-2');

    await h.service.decide(
      'finance-2',
      'refund-1',
      {
        approve: true,
        amount: 0,
        reason: 'The job was finished.',
      },
      IDEM,
    );

    expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'refund-1', status: 'pending_approval' },
      data: { status: 'awaiting_second_approval', amount: 0n },
    });
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
    expect(h.effects.approvalCloses).toEqual([]);
  });

  it('after work: asks for an explanation with the 05 message', async () => {
    const h = build({
      cancellation: { id: 'cancellation-1', workStarted: true },
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.decide(
        'finance-2',
        'refund-1',
        {
          approve: true,
          amount: 100,
          reason: '  ',
        },
        IDEM,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Explain the refund amount after work has started.',
    });
  });

  it('an offline refund is approved and waits for the transfer; Paystack is not called', async () => {
    const h = build({ payment: { method: 'offline' } });
    asStaff(h, 'finance-2');

    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);

    expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
      data: { status: 'approved' },
    });
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('rejecting a cancellation refund raises a Finance item and notice', async () => {
    const h = build();
    asStaff(h, 'finance-2');

    await h.service.decide(
      'finance-2',
      'refund-1',
      {
        approve: false,
        reason: 'Wrong amount.',
      },
      IDEM,
    );

    expect(h.effects.approvalCloses).toEqual([
      { kind: 'refund', itemId: 'refund-1', reason: 'rejected' },
    ]);
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'refund', itemId: 'refund-1' },
    ]);
    expect(h.effects.notify).toEqual([
      { event: 'refund.rejected', params: { requestCode: 'XPR-00042' } },
    ]);
  });

  it('does not submit a new refund to Paystack after approval', async () => {
    const h = build();
    asStaff(h, 'finance-2');
    h.gateway.refund.mockRejectedValueOnce(
      new GatewayRejectedError('Transaction not found'),
    );
    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.effects.approvalOpens).toEqual([]);
  });

  it('keeps the refund approved for a separately recorded reserve transfer', async () => {
    const h = build();
    asStaff(h, 'finance-2');
    h.gateway.refund.mockRejectedValueOnce(new Error('socket hang up'));
    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.tx.refund.updateMany).toHaveBeenCalledTimes(1);
    const updateCalls = h.tx.refund.updateMany.mock.calls as unknown as Array<
      [
        {
          data: { status: string };
        },
      ]
    >;
    const updateCall = updateCalls[0][0];
    expect(updateCall.data.status).toBe('approved');
  });
});

describe('RefundsService.secondApprove', () => {
  const awaiting = {
    status: 'awaiting_second_approval',
    decidedBy: 'finance-2',
    amount: 120_000n,
    cancellation: { id: 'cancellation-1', workStarted: true },
  };
  const second = { approve: true, reason: 'Agreed, half the job was done.' };

  it('needs a Super admin', async () => {
    const h = build({ refund: awaiting });
    asStaff(h, 'finance-3');

    await expect(
      h.service.secondApprove('finance-3', 'refund-1', second),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('refuses the first decider, even a Super admin', async () => {
    const h = build({ refund: awaiting });
    asStaff(h, 'finance-2', { superAdmin: true });

    await expect(
      h.service.secondApprove('finance-2', 'refund-1', second),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Another staff member must decide this refund.',
    });
  });

  it('a positive amount is approved for the reserve transfer; Paystack is not called', async () => {
    const h = build({ refund: awaiting });
    asStaff(h, 'admin-1', { superAdmin: true });
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ ...awaiting, status: 'processing' }),
    );

    await h.service.secondApprove('admin-1', 'refund-1', second);

    expect(h.tx.refund.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'refund-1', status: 'awaiting_second_approval' },
      data: {
        status: 'approved',
        secondApprover: 'admin-1',
        version: { increment: 1 },
      },
    });
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('a zero amount is waived and resolves the cancellation in the same transaction (C-07)', async () => {
    const h = build({ refund: { ...awaiting, amount: 0n } });
    asStaff(h, 'admin-1', { superAdmin: true });

    await h.service.secondApprove('admin-1', 'refund-1', second);

    expect(h.tx.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-1', status: 'awaiting_second_approval' },
      data: {
        status: 'waived',
        secondApprover: 'admin-1',
        completedAt: NOW,
        version: { increment: 1 },
      },
    });
    expect(h.requestEvents.onRefundsResolved).toHaveBeenCalledWith(
      h.tx,
      'cancellation-1',
    );
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('does nothing when another approver got there first', async () => {
    const h = build({ refund: awaiting, claim: 0 });
    asStaff(h, 'admin-1', { superAdmin: true });

    await expect(
      h.service.secondApprove('admin-1', 'refund-1', second),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
  });
});

describe('RefundsService.reconcile', () => {
  const recorded = {
    status: 'processing',
    requestedBy: 'finance-1',
    transferRecordedBy: 'finance-2',
    transferReference: 'BANK-9',
    transferProofId: 'proof-1',
  };

  it('refuses the transfer recorder and the requester (C-22)', async () => {
    for (const userId of ['finance-2', 'finance-1']) {
      const h = build({ refund: recorded, payment: { method: 'offline' } });
      asStaff(h, userId);

      await expect(
        h.service.reconcile(userId, 'refund-1', 'Seen on the statement.'),
      ).rejects.toMatchObject({ status: 403 });
      expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
    }
  });

  it('claims processing -> completed with both people excluded in the where clause', async () => {
    const h = build({ refund: recorded, payment: { method: 'offline' } });
    asStaff(h, 'finance-3');

    await h.service.reconcile(
      'finance-3',
      'refund-1',
      'Seen on the statement.',
    );

    expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'refund-1',
        status: 'processing',
        transferRecordedBy: { not: 'finance-3' },
        requestedBy: { not: 'finance-3' },
      },
      data: { status: 'completed', reconciledBy: 'finance-3' },
    });
    expect(h.requestEvents.onRefundsResolved).toHaveBeenCalledWith(
      h.tx,
      'cancellation-1',
    );
  });

  it('is a conflict with no effect when the claim matches nothing', async () => {
    const h = build({
      refund: recorded,
      payment: { method: 'offline' },
      claim: 0,
    });
    asStaff(h, 'finance-3');

    await expect(
      h.service.reconcile('finance-3', 'refund-1', 'Seen on the statement.'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
  });
});

describe('RefundsService.retry', () => {
  it('does not retry Paystack refunds; Finance must arrange payment from the reserve', async () => {
    const h = build({
      refund: { status: 'failed', gatewayRefundId: 'gw-old' },
    });
    asStaff(h, 'finance-2');
    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.verifyRefund).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('refuses all Paystack refund retries, including previously submitted refunds', async () => {
    const h = build({
      refund: { status: 'processing', gatewayRefundId: 'gw-old' },
    });
    asStaff(h, 'finance-2');
    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.verifyRefund).not.toHaveBeenCalled();
    expect(h.gateway.listRefunds).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a refund that is still on its way through Paystack', async () => {
    const h = build({
      refund: { status: 'processing', gatewayRefundId: 'gw-1' },
    });
    asStaff(h, 'finance-2');
    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.verifyRefund).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('does not look up or adopt an ambiguous Paystack refund', async () => {
    const h = build({
      refund: { status: 'processing', updatedAt: LONG_AGO },
      listed: [{ id: 'gw-found', status: 'pending', amount: 500_000 }],
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.listRefunds).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });

  it('does not inspect gateway refunds associated with another XPro refund', async () => {
    const h = build({
      refund: { status: 'processing' },
      listed: [{ id: 'gw-other', status: 'processed', amount: 500_000 }],
    });
    asStaff(h, 'finance-2');
    h.prisma.refund.findMany.mockResolvedValue([
      { gatewayRefundId: 'gw-other' },
    ]);
    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('holds back a resubmission right after the last submission', async () => {
    const h = build({
      refund: { status: 'processing', updatedAt: new Date() },
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.listRefunds).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
  });

  it('only a failed or in-flight Paystack refund can be retried', async () => {
    const approved = build({ refund: { status: 'approved' } });
    asStaff(approved, 'finance-2');
    await expect(
      approved.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });

    const offline = build({
      refund: { status: 'failed' },
      payment: { method: 'offline' },
    });
    asStaff(offline, 'finance-2');
    await expect(
      offline.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not call Paystack when its previous refund status cannot be verified', async () => {
    const h = build({
      refund: { status: 'failed', gatewayRefundId: 'gw-old' },
    });
    asStaff(h, 'finance-2');
    h.gateway.verifyRefund.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      h.service.retry('finance-2', 'refund-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.verifyRefund).not.toHaveBeenCalled();
    expect(h.gateway.refund).not.toHaveBeenCalled();
    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
  });
});

describe('RefundsService.settleFromGateway', () => {
  const settle = (
    h: ReturnType<typeof build>,
    status: string,
    extra: { amount?: number } = {},
  ) => {
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );
    h.tx.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );
    const onSettled = jest.fn().mockResolvedValue(undefined);
    return {
      onSettled,
      run: () =>
        h.service.settleFromGateway(
          'refund-1',
          { id: 'gw-1', status, amount: extra.amount ?? 500_000 },
          { actor: null, onSettled },
        ),
    };
  };

  it('processed: completes the refund, the payment status and the cancellation in one transaction, from processing only (C-11)', async () => {
    const h = build();
    h.tx.payment.findUnique.mockResolvedValue(paymentRow());
    const { run, onSettled } = settle(h, 'processed');

    await expect(run()).resolves.toEqual({ applied: true });

    expect(h.tx.refund.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'refund-1',
        status: { in: ['processing', 'failed'] },
        OR: [{ gatewayRefundId: null }, { gatewayRefundId: 'gw-1' }],
      },
      data: {
        status: 'completed',
        completedAt: NOW,
        gatewayRefundId: 'gw-1',
        version: { increment: 1 },
      },
    });
    expect(h.tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: { status: 'refunded' },
    });
    expect(h.requestEvents.onRefundsResolved).toHaveBeenCalledWith(
      h.tx,
      'cancellation-1',
    );
    expect(onSettled).toHaveBeenCalledWith(h.tx);
    expect(h.runs[0].command).toBe('refund.gatewaySettled');
    expect(h.effects.approvalCloses).toEqual([
      { kind: 'refund', itemId: 'refund-1', reason: 'completed' },
    ]);
  });

  it('a repeated or out-of-order event matches nothing and changes nothing', async () => {
    const h = build({ claim: 0 });
    const { run, onSettled } = settle(h, 'processed');

    await expect(run()).resolves.toEqual({ applied: false });

    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
    expect(h.effects.notify).toEqual([]);
    expect(onSettled).toHaveBeenCalled();
  });

  it('failed or needs-attention: marks only a processing refund failed, with a Finance item and notice (C-11)', async () => {
    const h = build();
    const { run } = settle(h, 'needs-attention');

    await expect(run()).resolves.toEqual({ applied: true });

    expect(h.tx.refund.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'refund-1',
        status: 'processing',
        OR: [{ gatewayRefundId: null }, { gatewayRefundId: 'gw-1' }],
      },
      data: {
        status: 'failed',
        gatewayRefundId: 'gw-1',
        version: { increment: 1 },
      },
    });
    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'refund', itemId: 'refund-1' },
    ]);
    expect(h.effects.notify[0]).toMatchObject({
      event: 'refund.failed',
      params: { requestCode: 'XPR-00042', amount: 500_000 },
    });
  });

  it('never resolves the cancellation for a failed refund', async () => {
    const h = build();
    const { run } = settle(h, 'failed');

    await run();

    expect(h.requestEvents.onRefundsResolved).not.toHaveBeenCalled();
  });

  it('ignores a gateway amount that differs from the refund', async () => {
    const h = build();
    const { run, onSettled } = settle(h, 'processed', { amount: 1 });

    await expect(run()).resolves.toEqual({ applied: false });

    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalled();
  });

  it('does nothing for a refund XPro does not have', async () => {
    const h = build();
    h.prisma.refund.findUnique.mockResolvedValue(null);

    await expect(
      h.service.settleFromGateway(
        'missing',
        { id: 'gw-1', status: 'processed' },
        { actor: null },
      ),
    ).resolves.toEqual({ applied: false });
    expect(h.runs).toEqual([]);
  });
});

describe('RefundsService.request', () => {
  it('opens a pending refund for the full balance when it replaces a rejected cancellation refund', async () => {
    const h = build({
      otherRefunds: [{ amount: 500_000n, status: 'rejected' }],
    });
    asStaff(h, 'finance-2');
    h.tx.cancellation.findUnique.mockResolvedValue({
      id: 'cancellation-1',
      workStarted: false,
    });
    h.tx.refund.findMany.mockResolvedValue([
      { id: 'refund-old', amount: 500_000n, status: 'rejected' },
    ]);

    await h.service.request('finance-2', 'payment-1', {
      reason: 'Replace the rejected refund.',
    });

    expect(h.tx.refund.create.mock.calls[0][0]).toMatchObject({
      data: {
        paymentId: 'payment-1',
        cancellationId: 'cancellation-1',
        amount: 500_000n,
        status: 'pending_approval',
        requestedBy: 'finance-2',
      },
    });
    expect(h.effects.approvalCloses).toEqual([
      { kind: 'refund', itemId: 'refund-old', reason: 'replaced' },
    ]);
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'refund', itemId: 'refund-new' },
    ]);
    expect(h.effects.notify[0]).toMatchObject({ event: 'refund.requested' });
  });

  it('refuses a payment that is not settled', async () => {
    const h = build({ payment: { status: 'pending' } });
    asStaff(h, 'finance-2');

    await expect(
      h.service.request('finance-2', 'payment-1', { reason: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.refund.create).not.toHaveBeenCalled();
  });

  it('refuses more than the balance', async () => {
    const h = build({
      otherRefunds: [{ amount: 400_000n, status: 'completed' }],
    });
    asStaff(h, 'finance-2');
    h.tx.serviceRequest.findUnique.mockResolvedValue({
      status: 'in_progress',
      cancellationId: null,
    });

    await expect(
      h.service.request('finance-2', 'payment-1', {
        amount: 200_000,
        reason: 'Goodwill.',
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'This refund exceeds the amount available.',
    });
  });
});

describe('RefundsService.recordTransfer', () => {
  it('records the external transfer after reserve authorization', async () => {
    const h = build({
      refund: { status: 'processing', transferRecordedBy: 'finance-2' },
      payment: { method: 'offline' },
    });
    asStaff(h, 'finance-2');

    await h.service.recordTransfer('finance-2', 'refund-1', {
      reference: 'BANK-9',
      proofFileId: 'upload-1',
    });

    expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'refund-1',
        status: 'processing',
        transferRecordedBy: 'finance-2',
        transferReference: null,
        transferProofId: null,
      },
      data: {
        transferReference: 'BANK-9',
        transferProofId: 'upload-1',
        version: { increment: 1 },
      },
    });
    expect(h.uploads.attach).toHaveBeenCalledWith(
      h.tx,
      ['upload-1'],
      'finance-2',
      'payment_proof',
      'refund',
      'refund-1',
    );
  });

  it('is a conflict when the claim matches nothing', async () => {
    const h = build({
      refund: { status: 'processing', transferRecordedBy: 'finance-2' },
      payment: { method: 'offline' },
      claim: 0,
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.recordTransfer('finance-2', 'refund-1', {
        reference: 'BANK-9',
        proofFileId: 'upload-1',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.uploads.attach).not.toHaveBeenCalled();
  });
});

describe('RefundsService.list (C-42, E-27)', () => {
  const lister = (permissions: string[]) => {
    const h = build();
    h.actors.resolve.mockResolvedValue({
      ...staff('finance-1'),
      staff: {
        ...(staff('finance-1').staff as object),
        permissions: new Set(permissions),
      },
    });
    const prisma = h.prisma as unknown as {
      refund: { findMany: jest.Mock; count: jest.Mock };
      payment: { findMany: jest.Mock };
      $transaction: jest.Mock;
    };
    prisma.refund.findMany.mockResolvedValue([
      refundRow({
        transferProofId: 'proof-secret',
        decidedBy: 'decider-secret',
      }),
    ]);
    prisma.refund.count = jest.fn().mockResolvedValue(1);
    prisma.payment.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'payment-1', method: 'paystack' }]);
    prisma.$transaction = jest.fn((queries: Array<Promise<unknown>>) =>
      Promise.all(queries),
    );
    return { h, prisma };
  };

  it('returns allow-list rows with the amount for view.pricing holders', async () => {
    const { h } = lister(['refund.manage', 'view.pricing']);

    const page = await h.service.list('finance-1', { page: 1 });

    expect(page.items[0]).toMatchObject({
      id: 'refund-1',
      amount: 500_000,
      method: 'paystack',
    });
    expect(JSON.stringify(page)).not.toContain('proof-secret');
    expect(JSON.stringify(page)).not.toContain('decider-secret');
  });

  it('masks the amount without view.pricing', async () => {
    const { h } = lister(['refund.manage']);

    const page = await h.service.list('finance-1');

    expect(page.items[0].amount).toBeNull();
  });

  it('filters by status and refuses an unknown one', async () => {
    const { h, prisma } = lister(['refund.manage']);

    await h.service.list('finance-1', { status: 'failed' });
    expect(prisma.refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'failed' } }),
    );
    await expect(
      h.service.list('finance-1', { status: 'bogus' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('refund audit rows, notices and versions (C-21, C-24, C-46)', () => {
  type Row = {
    resourceType: string;
    resourceId: string;
    note?: string;
    changes: {
      reference?: string;
      before: unknown;
      after: unknown;
      [key: string]: unknown;
    };
  };
  const auditRow = (h: ReturnType<typeof build>, action: string): Row => {
    const found = h.effects.audit.find((entry) => entry.action === action);
    if (!found) throw new Error(`No audit row "${action}"`);
    return found.data as Row;
  };
  const events = (h: ReturnType<typeof build>) =>
    h.effects.notify.map(({ event }) => event);

  it('decide: audits before/after with the payment reference and note, and tells Finance and the customer', async () => {
    const h = build();
    asStaff(h, 'finance-2');
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing' }),
    );

    await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);

    expect(auditRow(h, 'Refund approved')).toMatchObject({
      resourceType: 'refund',
      resourceId: 'refund-1',
      note: 'Customer cancelled early.',
      changes: {
        reference: 'xpro_abc',
        before: { status: 'pending_approval', amount: 500_000 },
        after: { status: 'approved', amount: 500_000 },
      },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.decided',
        params: {
          requestCode: 'XPR-00042',
          outcome: 'approved',
          amount: 500_000,
        },
      },
      {
        event: 'refund.approved_customer',
        params: { requestCode: 'XPR-00042', amount: 500_000 },
      },
    ]);
  });

  it('decide after work: tells Finance and Super admins a second approval is needed, and not the customer', async () => {
    const h = build({
      cancellation: { id: 'cancellation-1', workStarted: true },
    });
    asStaff(h, 'finance-2');

    await h.service.decide(
      'finance-2',
      'refund-1',
      { approve: true, amount: 120_000, reason: 'Half the job was done.' },
      IDEM,
    );

    expect(
      auditRow(h, 'Refund approved (awaiting second approval)').changes,
    ).toMatchObject({
      before: { status: 'pending_approval' },
      after: { status: 'awaiting_second_approval', amount: 120_000 },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.decided',
        params: {
          requestCode: 'XPR-00042',
          outcome: 'awaiting_second_approval',
          amount: 120_000,
        },
      },
    ]);
  });

  it('decide: a rejected refund that is not part of a cancellation is still announced', async () => {
    const h = build({ refund: { cancellationId: null }, cancellation: null });
    asStaff(h, 'finance-2');

    await h.service.decide(
      'finance-2',
      'refund-1',
      { approve: false, reason: 'Duplicate request.' },
      IDEM,
    );

    expect(auditRow(h, 'Refund rejected').note).toBe('Duplicate request.');
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.decided',
        params: {
          requestCode: 'XPR-00042',
          outcome: 'rejected',
          amount: 500_000,
        },
      },
    ]);
  });

  it('secondApprove: audits both approvers and announces the approval', async () => {
    const h = build({
      refund: {
        status: 'awaiting_second_approval',
        decidedBy: 'finance-2',
        amount: 120_000n,
      },
      cancellation: { id: 'cancellation-1', workStarted: true },
    });
    asStaff(h, 'admin-1', { superAdmin: true });
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'approved', amount: 120_000n }),
    );

    await h.service.secondApprove('admin-1', 'refund-1', {
      approve: true,
      reason: 'Agreed.',
    });

    expect(auditRow(h, 'Refund approved (second approval)')).toMatchObject({
      resourceId: 'refund-1',
      note: 'Agreed.',
      changes: {
        decidedBy: 'finance-2',
        secondApprover: 'admin-1',
        before: { status: 'awaiting_second_approval' },
        after: { status: 'approved', amount: 120_000 },
      },
    });
    expect(events(h)).toEqual(['refund.decided', 'refund.approved_customer']);
  });

  it('recordTransfer: audits the transfer reference and proof, never a bank number', async () => {
    const h = build({
      refund: { status: 'processing', transferRecordedBy: 'finance-2' },
      payment: { method: 'offline' },
    });
    asStaff(h, 'finance-2');

    await h.service.recordTransfer('finance-2', 'refund-1', {
      reference: 'BANK-9',
      proofFileId: 'upload-1',
      note: 'Sent today.',
    });

    const row = auditRow(h, 'Refund transfer recorded');
    expect(row).toMatchObject({
      resourceType: 'refund',
      note: 'Sent today.',
      changes: {
        transferReference: 'BANK-9',
        proofFileId: 'upload-1',
        before: { status: 'processing' },
        after: { status: 'processing' },
      },
    });
    expect(JSON.stringify(row)).not.toMatch(/account/i);
  });

  it('reconcile: audits the second person and sends the completion notices', async () => {
    const h = build({
      refund: {
        status: 'processing',
        requestedBy: 'finance-1',
        transferRecordedBy: 'finance-2',
        transferReference: 'BANK-9',
        transferProofId: 'proof-1',
      },
      payment: { method: 'offline' },
    });
    asStaff(h, 'finance-3');

    await h.service.reconcile('finance-3', 'refund-1', 'Seen on statement.');

    expect(auditRow(h, 'Refund reconciled')).toMatchObject({
      note: 'Seen on statement.',
      changes: {
        transferRecordedBy: 'finance-2',
        reconciledBy: 'finance-3',
        before: { status: 'processing' },
        after: { status: 'completed' },
      },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.completed',
        params: { requestCode: 'XPR-00042', amount: 500_000 },
      },
      {
        event: 'refund.completed_customer',
        params: { requestCode: 'XPR-00042', amount: 500_000 },
      },
    ]);
  });

  it('a gateway completion sends the receipt to the customer, with an audit row', async () => {
    const h = build();
    h.tx.payment.findUnique.mockResolvedValue(paymentRow());
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );
    h.tx.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );

    await h.service.settleFromGateway(
      'refund-1',
      { id: 'gw-1', status: 'processed', amount: 500_000 },
      { actor: null },
    );

    expect(auditRow(h, 'Refund completed').changes).toMatchObject({
      reference: 'xpro_abc',
      gatewayRefundId: 'gw-1',
      before: { status: 'processing' },
      after: { status: 'completed' },
    });
    expect(events(h)).toEqual([
      'refund.completed',
      'refund.completed_customer',
    ]);
  });

  it('a gateway amount that differs is audited and raises the mismatch alert instead of vanishing', async () => {
    const h = build();
    h.prisma.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );
    h.tx.refund.findUnique.mockResolvedValue(
      refundRow({ status: 'processing', gatewayRefundId: 'gw-1' }),
    );

    await h.service.settleFromGateway(
      'refund-1',
      { id: 'gw-1', status: 'processed', amount: 1 },
      { actor: null },
    );

    expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
    expect(auditRow(h, 'Refund event not applied').changes).toMatchObject({
      reason: 'amount_mismatch',
      reportedAmount: 1,
      before: { status: 'processing', amount: 500_000 },
      after: { status: 'processing', amount: 500_000 },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.mismatch',
        params: {
          requestCode: 'XPR-00042',
          approvedAmount: 500_000,
          reportedAmount: 1,
        },
      },
    ]);
  });

  it('request: audits the new refund from nothing to pending', async () => {
    const h = build({ otherRefunds: [] });
    asStaff(h, 'finance-2');
    h.tx.cancellation.findUnique.mockResolvedValue({
      id: 'cancellation-1',
      workStarted: false,
    });

    await h.service.request('finance-2', 'payment-1', {
      reason: 'Cancelled before work.',
    });

    expect(auditRow(h, 'Refund requested')).toMatchObject({
      resourceType: 'refund',
      resourceId: 'refund-new',
      note: 'Cancelled before work.',
      changes: {
        reference: 'xpro_abc',
        before: null,
        after: { status: 'pending_approval', amount: 500_000 },
      },
    });
  });

  describe('version and Idempotency-Key (C-46)', () => {
    it('refuses a stale If-Match with 409 VERSION_CONFLICT before anything changes', async () => {
      const h = build({ refund: { version: 3 } });
      asStaff(h, 'finance-2');

      await expect(
        h.service.decide('finance-2', 'refund-1', decideDto, IDEM, 2),
      ).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
        message: 'This record has changed. Refresh and retry.',
      });
      expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
      expect(h.effects.audit).toEqual([]);
    });

    it('accepts the current version, and every claim bumps it', async () => {
      const h = build({ refund: { version: 3 } });
      asStaff(h, 'finance-2');
      h.prisma.refund.findUnique.mockResolvedValue(
        refundRow({ status: 'processing', version: 4 }),
      );
      h.prisma.refund.findUniqueOrThrow.mockResolvedValue(
        refundRow({ status: 'processing', version: 4 }),
      );

      const view = await h.service.decide(
        'finance-2',
        'refund-1',
        decideDto,
        IDEM,
        3,
      );

      expect(h.tx.refund.updateMany.mock.calls[0][0]).toMatchObject({
        data: { version: { increment: 1 } },
      });
      expect(view).toMatchObject({ version: 4 });
    });

    it.each([
      [
        'secondApprove',
        (h: ReturnType<typeof build>) =>
          h.service.secondApprove(
            'admin-1',
            'refund-1',
            { approve: true, reason: 'OK.' },
            1,
          ),
        { status: 'awaiting_second_approval', version: 2 },
        'admin-1',
      ],
      [
        'recordTransfer',
        (h: ReturnType<typeof build>) =>
          h.service.recordTransfer(
            'finance-2',
            'refund-1',
            { reference: 'BANK-9', proofFileId: 'upload-1' },
            1,
          ),
        { status: 'approved', version: 2 },
        'finance-2',
      ],
      [
        'reconcile',
        (h: ReturnType<typeof build>) =>
          h.service.reconcile('finance-3', 'refund-1', 'Seen.', 1),
        { status: 'processing', transferRecordedBy: 'finance-2', version: 2 },
        'finance-3',
      ],
    ])('%s refuses a stale If-Match', async (_name, call, refund, userId) => {
      const h = build({ refund, payment: { method: 'offline' } });
      asStaff(h, userId, { superAdmin: true });

      await expect(call(h)).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
    });

    it('replays a stored decision for the same Idempotency-Key without touching the refund', async () => {
      const h = build();
      asStaff(h, 'finance-2');
      h.idempotency.lookup.mockResolvedValue({
        status: 200,
        body: { id: 'refund-1', status: 'approved', version: 2 },
      });

      await expect(
        h.service.decide('finance-2', 'refund-1', decideDto, IDEM),
      ).resolves.toEqual({ id: 'refund-1', status: 'approved', version: 2 });
      expect(h.tx.refund.updateMany).not.toHaveBeenCalled();
      expect(h.idempotency.store).not.toHaveBeenCalled();
    });

    it('stores the decision under the key once it has been made', async () => {
      const h = build();
      asStaff(h, 'finance-2');
      h.prisma.refund.findUnique.mockResolvedValue(
        refundRow({ status: 'processing' }),
      );

      await h.service.decide('finance-2', 'refund-1', decideDto, IDEM);

      expect(h.idempotency.lookup).toHaveBeenCalledWith(
        'finance-2',
        'idem-key-0001',
        expect.any(String),
      );
      expect(h.idempotency.store).toHaveBeenCalledWith(
        'finance-2',
        'idem-key-0001',
        expect.any(String),
        200,
        expect.objectContaining({ id: 'refund-1' }),
      );
    });
  });
});
