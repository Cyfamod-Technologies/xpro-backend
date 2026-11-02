import { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import type { RequestUser } from '../common/types/request-user';
import {
  quote as quoteSnapshot,
  snapshot,
} from '../requests/domain/guard.testkit';
import type { RequestSnapshot } from '../requests/domain/snapshot';
import { RequestEventsService } from '../requests/events/request-events.service';
import { systemCommandKit } from '../requests/system-command.testkit';
import type { VerifiedTransaction } from './payment-gateway';
import {
  AMOUNT_MISMATCH,
  NOT_AWAITING_PAYMENT,
  PAYMENT_IN_PROGRESS,
  PaymentsService,
  SAME_ACTOR_RECONCILE,
} from './payments.service';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const minutes = 60_000;

const finance = (userId = 'finance-1'): ActorContext =>
  ({
    userId,
    kind: 'staff',
    displayName: 'Finance',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: [],
      permissions: new Set(['payment.record', 'view.pricing']),
      canOwn: false,
      isSuperAdmin: false,
      permVersion: 1,
    },
  }) as unknown as ActorContext;
const customerActor = (userId = 'customer-1'): ActorContext => ({
  userId,
  kind: 'customer',
  displayName: 'Customer',
  platformRoles: ['customer'],
  accountActive: true,
});

const awaitingPayment = (overrides: Partial<RequestSnapshot> = {}) =>
  snapshot({
    number: 'XPR-00042',
    status: 'awaiting_payment',
    intake: { state: 'approved' },
    latestQuote: quoteSnapshot('accepted'),
    quotes: [quoteSnapshot('accepted')],
    ...overrides,
  });
const recordedOffline = (overrides: Partial<RequestSnapshot> = {}) =>
  awaitingPayment({
    payment: {
      paid: false,
      pendingPaymentAt: new Date(NOW.getTime() - 60 * minutes),
      offlineRecorded: true,
    },
    ...overrides,
  });

const acceptedQuote = { id: 'quote-1', version: 1, total: 500_000n };
const offlineRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1',
  requestId: 'request-1',
  quoteId: 'quote-1',
  quoteVersion: 1,
  amount: 500_000n,
  method: 'offline',
  channel: 'bank_transfer',
  status: 'recorded',
  reference: 'BANK-1',
  paidAt: new Date(NOW.getTime() - 24 * 60 * minutes),
  proofUploadId: 'upload-1',
  recordedBy: 'finance-1',
  reconciledBy: null,
  reconciledAt: null,
  note: null,
  failureReason: null,
  createdAt: new Date(NOW.getTime() - 60 * minutes),
  ...overrides,
});

function build(
  options: {
    snap?: RequestSnapshot;
    tx?: Record<string, unknown>;
    prisma?: Record<string, unknown>;
    gateway?: Record<string, unknown>;
    idempotency?: Record<string, unknown>;
  } = {},
) {
  const tx = {
    quote: {
      findFirst: jest.fn().mockResolvedValue(acceptedQuote),
      findUnique: jest.fn().mockResolvedValue({ ...acceptedQuote }),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(offlineRow(args.data)),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ email: 'owner@example.com' }),
    },
    idempotencyKey: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...options.tx,
  };
  const kit = systemCommandKit({
    tx,
    now: NOW,
    snap: options.snap ?? awaitingPayment(),
  });
  const prisma = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(offlineRow()),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ quoteId: 'quote-1' }),
    },
    idempotencyKey: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...options.prisma,
  };
  const idempotency = {
    lookup: jest.fn().mockResolvedValue(null),
    ...options.idempotency,
  };
  const gateway = {
    initialize: jest
      .fn()
      .mockResolvedValue({ authorizationUrl: 'https://checkout.test/abc' }),
    verify: jest.fn(),
    ...options.gateway,
  };
  const uploads = { attach: jest.fn().mockResolvedValue([]) };
  const requestEvents = {
    onPaymentSettled: jest.fn().mockResolvedValue({
      settled: true,
      afterCommit: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const dispatcher = { dispatchAlert: jest.fn().mockResolvedValue(undefined) };
  const actors = { resolve: jest.fn() };
  const service = new PaymentsService(
    prisma as never,
    actors as never,
    idempotency as never,
    gateway as never,
    uploads as never,
    requestEvents as never,
    kit.runner,
    dispatcher as never,
  );
  return {
    service,
    tx,
    prisma,
    gateway,
    uploads,
    requestEvents,
    dispatcher,
    actors,
    idempotency,
    ...kit,
  };
}

const recordDto = {
  amount: 500_000,
  channel: 'bank_transfer',
  reference: 'BANK-1',
  paidAt: '2026-10-24T09:00:00.000Z',
  proofFileId: 'upload-1',
};

describe('PaymentsService.recordOffline', () => {
  const setup = (overrides: Parameters<typeof build>[0] = {}) => {
    const harness = build(overrides);
    harness.actors.resolve.mockResolvedValue(finance());
    return harness;
  };

  it('runs under the payment.recordOffline guard and returns an allow-list DTO', async () => {
    const { service, tx, uploads, effects, runs } = setup();

    const result = await service.recordOffline(
      'finance-1',
      'XPR-00042',
      recordDto,
    );

    expect(runs[0].command).toBe('payment.recordOffline');
    expect(uploads.attach).toHaveBeenCalledWith(
      tx,
      ['upload-1'],
      'finance-1',
      'payment_proof',
      'payment',
      expect.any(String),
    );
    expect(result).toMatchObject({
      amount: 500_000,
      status: 'recorded',
      reference: 'BANK-1',
      proofFileId: 'upload-1',
    });
    expect(result).not.toHaveProperty('gatewayTransactionId');
    expect(result).not.toHaveProperty('lateRefundOpened');
    expect(effects.approvalOpens[0]).toMatchObject({ kind: 'offline_payment' });
    expect(effects.notify[0].event).toBe('payment.offline_recorded');
    expect(effects.audit[0].action).toBe('Offline payment recorded');
  });

  it.each([undefined, '', '   '])(
    'refuses a missing proof (%p) with the spec message before any write',
    async (proofFileId) => {
      const { service, tx } = setup();

      await expect(
        service.recordOffline('finance-1', 'XPR-00042', {
          ...recordDto,
          proofFileId,
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          message: 'Attach proof of the payment before recording it.',
        },
      });
      expect(tx.payment.create).not.toHaveBeenCalled();
    },
  );

  it('is refused by the guard once the quote is no longer awaiting payment', async () => {
    const { service, tx } = setup({
      snap: awaitingPayment({ status: 'matched' }),
    });

    await expect(
      service.recordOffline('finance-1', 'XPR-00042', recordDto),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: NOT_AWAITING_PAYMENT },
    });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('needs the exact amount due', async () => {
    const { service } = setup();

    await expect(
      service.recordOffline('finance-1', 'XPR-00042', {
        ...recordDto,
        amount: 499_999,
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: AMOUNT_MISMATCH },
    });
  });

  it('refuses a payment date in the future', async () => {
    const { service } = setup();

    await expect(
      service.recordOffline('finance-1', 'XPR-00042', {
        ...recordDto,
        paidAt: '2026-10-26T09:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('maps a reused reference to 409, including a race that surfaces as P2002', async () => {
    const reused = setup({
      tx: {
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue({ id: 'other' }),
        },
      },
    });
    await expect(
      reused.service.recordOffline('finance-1', 'XPR-00042', recordDto),
    ).rejects.toMatchObject({ status: 409 });

    const raced = setup();
    raced.tx.payment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      raced.service.recordOffline('finance-1', 'XPR-00042', recordDto),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses staff without payment.record', async () => {
    const harness = build();
    harness.actors.resolve.mockResolvedValue({
      ...finance(),
      staff: { ...finance().staff, permissions: new Set() },
    });

    await expect(
      harness.service.recordOffline('finance-1', 'XPR-00042', recordDto),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('PaymentsService.reconcile', () => {
  const setup = (overrides: Parameters<typeof build>[0] = {}) => {
    const harness = build({
      snap: recordedOffline(),
      ...overrides,
    });
    harness.actors.resolve.mockResolvedValue(finance('finance-2'));
    harness.tx.payment.findUnique.mockResolvedValue(offlineRow());
    harness.tx.payment.findUniqueOrThrow.mockResolvedValue(
      offlineRow({ status: 'paid', reconciledBy: 'finance-2' }),
    );
    return harness;
  };

  it('claims recorded -> paid and settles the request in the same transaction', async () => {
    const { service, tx, requestEvents, effects, runs } = setup();

    const result = await service.reconcile(
      'finance-2',
      'payment-1',
      'Seen on the statement.',
    );

    expect(runs[0].command).toBe('payment.reconcile');
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        status: 'recorded',
        recordedBy: { not: 'finance-2' },
      },
      data: expect.objectContaining({
        status: 'paid',
        reconciledBy: 'finance-2',
      }) as unknown,
    });
    expect(requestEvents.onPaymentSettled).toHaveBeenCalledWith(
      tx,
      'request-1',
      'quote-1',
      'payment-1',
    );
    expect(effects.approvalCloses[0]).toMatchObject({
      kind: 'offline_payment',
      itemId: 'payment-1',
      reason: 'reconciled',
    });
    expect(result.status).toBe('paid');
  });

  it('refuses the recorder with 403 and the 05 message, and claims nothing', async () => {
    const { service, tx, requestEvents, actors } = setup();
    actors.resolve.mockResolvedValue(finance('finance-1'));

    await expect(
      service.reconcile('finance-1', 'payment-1', 'Seen on the statement.'),
    ).rejects.toMatchObject({
      status: 403,
      response: { message: SAME_ACTOR_RECONCILE },
    });
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
  });

  it('is refused by the guard when no offline payment is recorded', async () => {
    const { service, requestEvents } = setup({ snap: awaitingPayment() });

    await expect(
      service.reconcile('finance-2', 'payment-1', 'Seen.'),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: 'This payment is not awaiting reconciliation.' },
    });
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
  });

  it('is refused by the guard when the note is blank', async () => {
    const { service } = setup();

    await expect(
      service.reconcile('finance-2', 'payment-1', '  '),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: 'Add a reconciliation note.' },
    });
  });

  it.each(['matched', 'cancelled', 'cancelling', 'closed'] as const)(
    'still marks a late payment on a %s request paid and hands it to the settlement event (which opens the refund)',
    async (status) => {
      const { service, tx, requestEvents } = setup({
        snap: recordedOffline({ status }),
      });

      await service.reconcile(
        'finance-2',
        'payment-1',
        'Seen on the statement.',
      );

      expect(tx.payment.updateMany).toHaveBeenCalled();
      expect(requestEvents.onPaymentSettled).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a lost claim with 409 and no settlement', async () => {
    const { service, tx, requestEvents } = setup();
    tx.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reconcile('finance-2', 'payment-1', 'Seen.'),
    ).rejects.toMatchObject({ status: 409 });
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
  });

  it('needs the payment amount to equal its quote total', async () => {
    const { service, tx } = setup();
    tx.quote.findUnique.mockResolvedValue({
      ...acceptedQuote,
      total: 600_000n,
    });

    await expect(
      service.reconcile('finance-2', 'payment-1', 'Seen.'),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: AMOUNT_MISMATCH },
    });
  });
});

describe('PaymentsService.reconcile of a late offline payment', () => {
  it('marks it paid and opens one full pending refund, leaving the lapsed request alone', async () => {
    const tx = {
      quote: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...acceptedQuote, status: 'expired' }),
      },
      payment: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...offlineRow(), lateRefundOpened: false }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(offlineRow({ status: 'paid' })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      refund: { create: jest.fn().mockResolvedValue({ id: 'refund-9' }) },
      serviceRequest: { update: jest.fn() },
    };
    const kit = systemCommandKit({
      tx,
      now: NOW,
      snap: recordedOffline({ status: 'matched' }),
    });
    const realEvents = new RequestEventsService({} as never, kit.runner);
    const service = new PaymentsService(
      {
        payment: {
          findUnique: jest.fn().mockResolvedValue({ requestId: 'request-1' }),
        },
      } as never,
      { resolve: jest.fn().mockResolvedValue(finance('finance-2')) } as never,
      {} as never,
      {} as never,
      {} as never,
      realEvents,
      kit.runner,
      {} as never,
    );

    const result = await service.reconcile(
      'finance-2',
      'payment-1',
      'Seen on the statement.',
    );

    expect(result.status).toBe('paid');
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'recorded' }) as unknown,
      data: expect.objectContaining({ status: 'paid' }) as unknown,
    });
    expect(tx.refund.create).toHaveBeenCalledTimes(1);
    expect(tx.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-1',
        amount: 500_000n,
        status: 'pending_approval',
        requestedBy: 'system',
      }) as unknown,
    });
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(kit.effects.notify.map((entry) => entry.event)).toEqual([
      'refund.requested',
      'payment.late',
      'payment.late_customer',
    ]);
    expect(kit.effects.approvalOpens).toContainEqual({
      kind: 'refund',
      itemId: 'refund-9',
    });
  });
});

describe('PaymentsService.rejectOffline', () => {
  const setup = (overrides: Parameters<typeof build>[0] = {}) => {
    const harness = build({ snap: recordedOffline(), ...overrides });
    harness.actors.resolve.mockResolvedValue(finance('finance-2'));
    harness.tx.payment.findUnique.mockResolvedValue(offlineRow());
    harness.tx.payment.findUniqueOrThrow.mockResolvedValue(
      offlineRow({ status: 'failed' }),
    );
    return harness;
  };

  it('fails the recorded payment under the payment.rejectOffline guard', async () => {
    const { service, tx, effects, runs } = setup();

    const result = await service.rejectOffline(
      'finance-2',
      'payment-1',
      'Not on the statement.',
    );

    expect(runs[0].command).toBe('payment.rejectOffline');
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        status: 'recorded',
        recordedBy: { not: 'finance-2' },
      },
      data: expect.objectContaining({ status: 'failed' }) as unknown,
    });
    expect(effects.approvalCloses[0]).toMatchObject({ reason: 'rejected' });
    expect(result.status).toBe('failed');
  });

  it('refuses the recorder with 403 and the 05 message', async () => {
    const { service, actors } = setup();
    actors.resolve.mockResolvedValue(finance('finance-1'));

    await expect(
      service.rejectOffline('finance-1', 'payment-1', 'No.'),
    ).rejects.toMatchObject({
      status: 403,
      response: { message: SAME_ACTOR_RECONCILE },
    });
  });

  it('is refused by the guard without a recorded payment or a reason', async () => {
    await expect(
      setup({ snap: awaitingPayment() }).service.rejectOffline(
        'finance-2',
        'payment-1',
        'No.',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setup().service.rejectOffline('finance-2', 'payment-1', ' '),
    ).rejects.toMatchObject({
      status: 422,
      response: { message: 'Add a reason for rejecting this payment.' },
    });
  });
});

describe('PaymentsService.initiate', () => {
  const user = { id: 'customer-1' } as unknown as RequestUser;
  const setup = (overrides: Parameters<typeof build>[0] = {}) => {
    const harness = build(overrides);
    harness.actors.resolve.mockResolvedValue(customerActor());
    return harness;
  };

  it('commits the pending attempt, its 30-minute check and the idempotency reservation before calling Paystack', async () => {
    const { service, tx, gateway, effects, prisma } = setup();
    const order: string[] = [];
    tx.idempotencyKey.createMany.mockImplementation(() => {
      order.push('reserve');
      return Promise.resolve({ count: 1 });
    });
    gateway.initialize.mockImplementation(() => {
      order.push('gateway');
      return Promise.resolve({ authorizationUrl: 'https://checkout.test/abc' });
    });

    const result = await service.initiate(
      user,
      'XPR-00042',
      'key-1',
      '/requests/XPR-00042/payments',
    );

    expect(order).toEqual(['reserve', 'gateway']);
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: 'paystack',
        status: 'pending',
        amount: 500_000n,
      }) as unknown,
    });
    expect(effects.timerStarts).toEqual([
      {
        kind: 'payment.pendingCheck',
        dueAt: new Date(NOW.getTime() + 30 * minutes),
        refId: expect.any(String) as unknown,
        payload: undefined,
      },
    ]);
    expect(result).toMatchObject({
      authorizationUrl: 'https://checkout.test/abc',
    });
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalled();
    expect(gateway.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500_000,
        metadata: expect.objectContaining({
          requestId: 'request-1',
          quoteId: 'quote-1',
        }) as unknown,
      }),
    );
  });

  it('blocks a second checkout while an attempt is younger than 30 minutes', async () => {
    const { service, gateway, tx } = setup({
      snap: awaitingPayment({
        payment: {
          paid: false,
          pendingPaymentAt: new Date(NOW.getTime() - 10 * minutes),
          offlineRecorded: false,
        },
      }),
    });

    await expect(
      service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'PAYMENT_IN_PROGRESS',
      response: { message: PAYMENT_IN_PROGRESS },
    });
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(gateway.initialize).not.toHaveBeenCalled();
  });

  it('allows a new checkout once the earlier attempt is 30 minutes old', async () => {
    const { service } = setup({
      snap: awaitingPayment({
        payment: {
          paid: false,
          pendingPaymentAt: new Date(NOW.getTime() - 31 * minutes),
          offlineRecorded: false,
        },
      }),
    });

    await expect(
      service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).resolves.toMatchObject({ reference: expect.any(String) as unknown });
  });

  it('refuses when the quote is no longer awaiting payment', async () => {
    const { service } = setup({ snap: awaitingPayment({ status: 'matched' }) });

    await expect(
      service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).rejects.toMatchObject({
      status: 409,
      response: { message: NOT_AWAITING_PAYMENT },
    });
  });

  it('marks the attempt failed, stops its check and releases the key when Paystack fails', async () => {
    const { service, gateway, tx, effects, prisma, runs } = setup();
    gateway.initialize.mockRejectedValue(new Error('Paystack is down'));

    await expect(
      service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).rejects.toThrow('Paystack is down');

    expect(runs.map((run) => run.command)).toEqual([
      'payment.initiate',
      'payment.attemptFailed',
    ]);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String) as unknown, status: 'pending' },
      data: expect.objectContaining({ status: 'failed' }) as unknown,
    });
    expect(effects.timerStops).toEqual([
      { kind: 'payment.pendingCheck', refId: expect.any(String) as unknown },
    ]);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it('replays a completed response and refuses a replay while the first call is in flight', async () => {
    const stored = {
      paymentId: 'payment-1',
      authorizationUrl: 'https://checkout.test/abc',
      reference: 'xpro_1',
    };
    const done = setup({
      idempotency: {
        lookup: jest.fn().mockResolvedValue({ status: 202, body: stored }),
      },
    });
    await expect(
      done.service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).resolves.toEqual(stored);
    expect(done.tx.payment.create).not.toHaveBeenCalled();

    const inFlight = setup({
      idempotency: {
        lookup: jest.fn().mockResolvedValue({
          status: 202,
          body: { inFlight: true, paymentId: 'payment-1' },
        }),
      },
    });
    await expect(
      inFlight.service.initiate(user, 'XPR-00042', 'key-1', '/p'),
    ).rejects.toMatchObject({ status: 409, code: 'PAYMENT_IN_PROGRESS' });
  });
});

describe('PaymentsService.settleCharge', () => {
  const payment = {
    id: 'payment-1',
    requestId: 'request-1',
    quoteId: 'quote-1',
    status: 'pending',
  };
  const verified = {
    status: 'success',
    reference: 'xpro_1',
    amount: 500_000,
    currency: 'NGN',
    id: 4242,
    channel: 'card',
    paidAt: '2026-10-25T09:59:00.000Z',
  } as VerifiedTransaction;

  function settleSetup(claimCount: number) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'request-1' }]),
      payment: {
        updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      },
      auditLog: { create: jest.fn() },
    };
    const harness = build({
      prisma: {
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      },
    });
    return { ...harness, stx: tx };
  }

  it('locks the request, claims pending -> paid, audits and settles the request in one transaction', async () => {
    const { service, stx, requestEvents } = settleSetup(1);
    const order: string[] = [];
    stx.$queryRaw.mockImplementation(() => {
      order.push('lock');
      return Promise.resolve([]);
    });
    stx.payment.updateMany.mockImplementation(() => {
      order.push('claim');
      return Promise.resolve({ count: 1 });
    });
    requestEvents.onPaymentSettled.mockImplementation(() => {
      order.push('settle');
      return Promise.resolve({
        settled: true,
        afterCommit: jest.fn().mockResolvedValue(undefined),
      });
    });
    const onSettled = jest.fn(() => {
      order.push('inbox');
      return Promise.resolve();
    });

    const result = await service.settleCharge(payment, verified, {
      source: 'webhook',
      onSettled,
    });

    expect(order).toEqual(['lock', 'claim', 'settle', 'inbox']);
    expect(result).toEqual({ claimed: true });
    expect(stx.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        method: 'paystack',
        status: { in: ['pending', 'failed'] },
      },
      data: expect.objectContaining({
        status: 'paid',
        gatewayTransactionId: '4242',
      }) as unknown,
    });
    expect(stx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('has no effects at all when the conditional claim matches no row (duplicate or out-of-order event)', async () => {
    const { service, stx, requestEvents } = settleSetup(0);
    const onSettled = jest.fn().mockResolvedValue(undefined);

    const result = await service.settleCharge(payment, verified, {
      source: 'recheck',
      onSettled,
    });

    expect(result).toEqual({ claimed: false });
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
    expect(stx.auditLog.create).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('runs the after-commit hook only after the transaction returned', async () => {
    const { service, requestEvents } = settleSetup(1);
    const afterCommit = jest.fn().mockResolvedValue(undefined);
    requestEvents.onPaymentSettled.mockResolvedValue({
      settled: true,
      afterCommit,
    });

    await service.settleCharge(payment, verified, { source: 'webhook' });

    expect(afterCommit).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentsService.quarantine and recheckPending', () => {
  const payment = {
    id: 'payment-1',
    requestId: 'request-1',
    quoteId: 'quote-1',
    reference: 'xpro_1',
    amount: 500_000n,
    method: 'paystack',
    status: 'pending',
    createdAt: new Date(NOW.getTime() - 45 * minutes),
  };
  const verified = (overrides: Partial<VerifiedTransaction> = {}) =>
    ({
      status: 'success',
      reference: 'xpro_1',
      amount: 500_000,
      currency: 'NGN',
      customer: { email: 'owner@example.com' },
      metadata: {
        paymentId: 'payment-1',
        requestId: 'request-1',
        quoteId: 'quote-1',
      },
      ...overrides,
    }) as VerifiedTransaction;

  function quarantineSetup(alreadyAlerted = false) {
    const qtx = {
      auditLog: {
        findFirst: jest
          .fn()
          .mockResolvedValue(alreadyAlerted ? { id: 'audit-1' } : null),
        create: jest.fn(),
      },
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({ number: 42 }),
      },
    };
    const harness = build({
      prisma: {
        payment: { findUnique: jest.fn().mockResolvedValue(payment) },
        serviceRequest: {
          findUnique: jest.fn().mockResolvedValue({ ownerId: 'customer-1' }),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ email: 'owner@example.com' }),
        },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(qtx)),
      },
    });
    return { ...harness, qtx };
  }

  it('audits a mismatch and sends the mandatory Finance alert once', async () => {
    const { service, qtx, dispatcher } = quarantineSetup();
    const inTx = jest.fn().mockResolvedValue(undefined);

    const result = await service.matchOrQuarantine(
      payment,
      verified({ amount: 1 }),
      inTx,
    );

    expect(result).toEqual({
      matches: false,
      reason: 'The transaction amount differs.',
    });
    expect(inTx).toHaveBeenCalledWith(qtx);
    expect(qtx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'Payment quarantined',
        entityType: 'payment',
        entityId: 'payment-1',
      }) as unknown,
    });
    expect(dispatcher.dispatchAlert).toHaveBeenCalledWith(
      qtx,
      'payment.quarantined',
      {
        requestCode: 'XPR-00042',
        reference: 'xpro_1',
        reason: 'The transaction amount differs.',
      },
    );
  });

  it('does not alert twice for the same payment', async () => {
    const { service, qtx, dispatcher } = quarantineSetup(true);

    await service.quarantine({
      payment,
      reference: 'xpro_1',
      reason: 'The transaction amount differs.',
    });

    expect(qtx.auditLog.create).not.toHaveBeenCalled();
    expect(dispatcher.dispatchAlert).not.toHaveBeenCalled();
  });

  it('alerts with the unmatched wording when no payment owns the reference', async () => {
    const { service, dispatcher } = quarantineSetup();

    await service.quarantine({
      payment: null,
      reference: 'ghost_ref',
      reason: 'No XPro payment has this reference.',
    });

    expect(dispatcher.dispatchAlert).toHaveBeenCalledWith(
      expect.anything(),
      'payment.quarantined_unmatched',
      {
        reference: 'ghost_ref',
        reason: 'No XPro payment has this reference.',
      },
    );
  });

  it('does not settle a mismatched recheck; it quarantines it', async () => {
    const { service, gateway, requestEvents, dispatcher } = quarantineSetup();
    gateway.verify.mockResolvedValue(verified({ currency: 'USD' }));

    await expect(service.recheckPending('payment-1')).resolves.toBe(
      'quarantined',
    );
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
    expect(dispatcher.dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it('settles a matching success on recheck', async () => {
    const { service, gateway, requestEvents } = quarantineSetup();
    gateway.verify.mockResolvedValue(verified());
    const settle = jest
      .spyOn(service, 'settleCharge')
      .mockResolvedValue({ claimed: true });

    await expect(service.recheckPending('payment-1')).resolves.toBe('settled');
    expect(settle).toHaveBeenCalledWith(
      payment,
      expect.anything(),
      expect.objectContaining({ source: 'recheck' }),
    );
    expect(requestEvents.onPaymentSettled).not.toHaveBeenCalled();
  });

  it('releases an attempt older than 30 minutes only when Paystack confirms no charge', async () => {
    const abandoned = quarantineSetup();
    abandoned.gateway.verify.mockResolvedValue(
      verified({ status: 'abandoned' }),
    );
    await expect(abandoned.service.recheckPending('payment-1')).resolves.toBe(
      'failed',
    );
    expect(abandoned.runs[0].command).toBe('payment.attemptFailed');

    const ongoing = quarantineSetup();
    ongoing.gateway.verify.mockResolvedValue(verified({ status: 'ongoing' }));
    await expect(ongoing.service.recheckPending('payment-1')).resolves.toBe(
      'pending',
    );
    expect(ongoing.runs).toEqual([]);
  });

  it('leaves a young attempt alone even if Paystack says abandoned', async () => {
    const young = quarantineSetup();
    young.prisma.payment.findUnique.mockResolvedValue({
      ...payment,
      createdAt: new Date(),
    });
    young.gateway.verify.mockResolvedValue(verified({ status: 'abandoned' }));

    await expect(young.service.recheckPending('payment-1')).resolves.toBe(
      'pending',
    );
  });

  it('ignores a payment that is no longer pending', async () => {
    const { service, prisma, gateway } = quarantineSetup();
    prisma.payment.findUnique.mockResolvedValue({ ...payment, status: 'paid' });

    await expect(service.recheckPending('payment-1')).resolves.toBeNull();
    expect(gateway.verify).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.getRequestPayments', () => {
  function projectionSetup(actor: ActorContext) {
    const harness = build({
      prisma: {
        serviceRequest: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'request-1', ownerId: 'customer-1' }),
        },
        quote: { findFirst: jest.fn().mockResolvedValue(acceptedQuote) },
        payment: {
          findMany: jest.fn().mockResolvedValue([
            offlineRow({
              status: 'paid',
              method: 'paystack',
              channel: 'card',
              reference: 'xpro_1',
            }),
          ]),
        },
        refund: { findMany: jest.fn().mockResolvedValue([]) },
        setting: { findUnique: jest.fn().mockResolvedValue(null) },
      },
    });
    harness.actors.resolve.mockResolvedValue(actor);
    return harness;
  }
  const requestId = '00000000-0000-4000-8000-000000000001';
  const user = (id: string) => ({ id }) as unknown as RequestUser;

  it('shows the customer total minus net settled collections', async () => {
    const { service } = projectionSetup(customerActor());

    const result = await service.getRequestPayments(
      user('customer-1'),
      requestId,
    );

    expect(result.amountDue).toBe(0);
    expect(result.payments[0]).toMatchObject({
      amount: 500_000,
      reference: 'xpro_1',
      channel: 'card',
    });
  });

  it('masks figures, references and channels for staff without view.pricing', async () => {
    const actor = finance();
    actor.staff!.permissions = new Set(['payment.record']);
    const { service } = projectionSetup(actor);

    const result = await service.getRequestPayments(
      user('finance-1'),
      requestId,
    );

    expect(result.amountDue).toBeNull();
    expect(result.payments[0].amount).toBeNull();
    expect(result.payments[0]).not.toHaveProperty('reference');
    expect(result.payments[0]).not.toHaveProperty('channel');
    expect(result.payments[0].status).toBe('paid');
  });

  it('answers an inactive staff member and a stranger with an opaque 404', async () => {
    const inactive = finance();
    inactive.staff!.status = 'suspended';
    await expect(
      projectionSetup(inactive).service.getRequestPayments(
        user('finance-1'),
        requestId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      projectionSetup(customerActor('someone-else')).service.getRequestPayments(
        user('someone-else'),
        requestId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('PaymentsService.listPlatformTransactions', () => {
  const requestRow = {
    id: 'request-1',
    number: 42,
    title: 'Interior painting',
    ownerId: 'customer-1',
    customerName: 'Ada Customer',
  };
  const paymentRow = {
    id: 'payment-1',
    amount: 500_000n,
    method: 'paystack',
    channel: null,
    gatewayChannel: 'card',
    status: 'paid',
    reference: 'xpro_ref_1',
    createdAt: NOW,
    paidAt: NOW,
    request: requestRow,
  };
  const buildListing = (actor: ActorContext) => {
    const prisma = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'customer-1', email: 'ada@example.com' }]),
      },
      payment: {
        findMany: jest.fn().mockResolvedValue([paymentRow]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest
        .fn()
        .mockImplementation((queries: Promise<unknown>[]) =>
          Promise.all(queries),
        ),
    };
    const actors = { resolve: jest.fn().mockResolvedValue(actor) };
    const service = new PaymentsService(
      prisma as never,
      actors as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('returns a paginated read-only allow-list with customer and request context', async () => {
    const { service, prisma } = buildListing(finance());

    const result = await service.listPlatformTransactions('finance-1', {
      page: 1,
      limit: 25,
      q: 'xpro_ref_1',
    });

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      limit: 25,
      totalPages: 1,
    });
    expect(result.items[0]).toMatchObject({
      id: 'payment-1',
      requestRecordId: 'request-1',
      requestId: 'XPR-00042',
      customerEmail: 'ada@example.com',
      amount: 500_000,
      channel: 'card',
      status: 'paid',
    });
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 25,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('requires payment.record permission', async () => {
    const actor = finance();
    actor.staff!.permissions = new Set();
    const { service } = buildListing(actor);

    await expect(
      service.listPlatformTransactions('finance-1'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('masks amount, reference and channel when view.pricing is absent', async () => {
    const actor = finance();
    actor.staff!.permissions = new Set(['payment.record']);
    const { service } = buildListing(actor);

    const result = await service.listPlatformTransactions('finance-1');

    expect(result.items[0]).toMatchObject({
      amount: null,
      reference: null,
      channel: null,
    });
    expect(result.items[0].status).toBe('paid');
  });
});

describe('PaymentsService.openForCancellation (C-39)', () => {
  const settledPayment = (overrides: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    requestId: 'request-1',
    amount: 500_000n,
    status: 'paid',
    ...overrides,
  });
  const setup = (
    payments: Array<Record<string, unknown>>,
    refunds: Array<{ amount: bigint; status: string }> = [],
  ) => {
    const order: string[] = [];
    const refundTx = {
      findMany: jest.fn((_args: unknown) => {
        order.push('refunds');
        return Promise.resolve(refunds);
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'refund-1', ...args.data }),
      ),
    };
    const harness = build({
      tx: {
        $queryRaw: jest.fn(() => {
          order.push('lock');
          return Promise.resolve([]);
        }),
        payment: {
          findMany: jest
            .fn()
            .mockResolvedValue(payments.map(({ id }) => ({ id }))),
          findUniqueOrThrow: jest.fn((args: { where: { id: string } }) =>
            Promise.resolve(
              payments.find((payment) => payment.id === args.where.id),
            ),
          ),
        },
        refund: refundTx,
      },
    });
    return { ...harness, order, refundTx };
  };
  const input = {
    cancellationId: 'cancellation-1',
    requestedBy: 'admin-1',
    workStarted: false,
  };

  it('looks at paid and partially refunded payments only', async () => {
    const h = setup([settledPayment()]);

    await h.service.openForCancellation(h.ctx, input);

    expect(h.tx.payment.findMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['paid', 'partially_refunded'] },
      },
      orderBy: { paidAt: 'desc' },
      select: { id: true },
    });
  });

  it('refunds what is left after completed refunds, not the whole payment', async () => {
    const h = setup(
      [settledPayment({ status: 'partially_refunded' })],
      [
        { amount: 200_000n, status: 'completed' },
        { amount: 100_000n, status: 'rejected' },
      ],
    );

    await h.service.openForCancellation(h.ctx, input);

    expect(h.refundTx.create.mock.calls[0][0]).toMatchObject({
      data: {
        paymentId: 'payment-1',
        cancellationId: 'cancellation-1',
        amount: 300_000n,
        status: 'pending_approval',
        requestedBy: 'admin-1',
      },
    });
  });

  it('locks the payment before it reads the refunds that hold its balance', async () => {
    const h = setup([settledPayment()]);

    await h.service.openForCancellation(h.ctx, input);

    expect(h.order).toEqual(['lock', 'refunds']);
  });

  it('opens the refund approval item and tells Finance', async () => {
    const h = setup([settledPayment()]);

    await h.service.openForCancellation(h.ctx, input);

    expect(h.effects.approvalOpens).toEqual([
      { kind: 'refund', itemId: 'refund-1' },
    ]);
    expect(h.effects.notify).toEqual([
      {
        event: 'refund.requested',
        params: { requestCode: 'XPR-00042', amount: 500_000 },
      },
    ]);
    expect(h.effects.audit[0]).toMatchObject({
      action: 'Refund opened for cancellation',
    });
  });

  it('opens one refund per settled payment with a balance and skips a drained one', async () => {
    const h = setup([
      settledPayment({ id: 'payment-1' }),
      settledPayment({ id: 'payment-2', amount: 100_000n }),
    ]);
    h.refundTx.findMany
      .mockResolvedValueOnce([{ amount: 500_000n, status: 'processing' }])
      .mockResolvedValueOnce([]);

    const opened = await h.service.openForCancellation(h.ctx, input);

    expect(opened).toEqual([{ id: 'refund-1', amount: 100_000n }]);
  });

  it('refuses a request with no settled payment', async () => {
    const h = setup([]);

    await expect(
      h.service.openForCancellation(h.ctx, input),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.refundTx.create).not.toHaveBeenCalled();
  });

  it('refuses when nothing is left to refund', async () => {
    const h = setup(
      [settledPayment()],
      [{ amount: 500_000n, status: 'completed' }],
    );

    await expect(
      h.service.openForCancellation(h.ctx, input),
    ).rejects.toMatchObject({
      status: 409,
      message: 'There is nothing left to refund on this payment.',
    });
  });
});

describe('payment audit rows and notices (C-21, C-24)', () => {
  type Row = {
    resourceType: string;
    resourceId: string;
    note?: string;
    changes: { reference?: string; before: unknown; after: unknown };
  };
  const rowOf = (
    effects: { audit: Array<{ action: string; data?: unknown }> },
    action: string,
  ): Row => {
    const found = effects.audit.find((entry) => entry.action === action);
    if (!found) throw new Error(`No audit row "${action}"`);
    return found.data as Row;
  };

  it('initiate audits the pending attempt from nothing, with its reference', async () => {
    const h = build();
    h.actors.resolve.mockResolvedValue(customerActor());

    await h.service.initiate(
      { id: 'customer-1' } as unknown as RequestUser,
      'XPR-00042',
      'key-1',
      '/requests/XPR-00042/payments',
    );

    expect(rowOf(h.effects, 'Payment initiated')).toMatchObject({
      resourceType: 'payment',
      changes: {
        reference: expect.stringMatching(/^xpro_/) as unknown,
        before: null,
        after: { status: 'pending', amount: 500_000 },
      },
    });
  });

  it('recordOffline audits the record from nothing, with the note and proof but no bank details', async () => {
    const h = build();
    h.actors.resolve.mockResolvedValue(finance());

    await h.service.recordOffline('finance-1', 'XPR-00042', {
      ...recordDto,
      note: 'Cash at the office.',
    });

    const row = rowOf(h.effects, 'Offline payment recorded');
    expect(row).toMatchObject({
      resourceType: 'payment',
      note: 'Cash at the office.',
      changes: {
        reference: 'BANK-1',
        before: null,
        after: { status: 'recorded', amount: 500_000 },
      },
    });
    expect(JSON.stringify(row)).not.toMatch(/account/i);
  });

  it('reconcile audits recorded -> paid with the second person and the note', async () => {
    const h = build({ snap: recordedOffline() });
    h.actors.resolve.mockResolvedValue(finance('finance-2'));
    h.tx.payment.findUnique.mockResolvedValue(offlineRow());
    h.tx.payment.findUniqueOrThrow.mockResolvedValue(
      offlineRow({ status: 'paid' }),
    );

    await h.service.reconcile('finance-2', 'payment-1', 'Seen on statement.');

    expect(rowOf(h.effects, 'Offline payment reconciled')).toMatchObject({
      resourceId: 'payment-1',
      note: 'Seen on statement.',
      changes: {
        reference: 'BANK-1',
        before: { status: 'recorded' },
        after: { status: 'paid' },
      },
    });
  });

  it('rejecting an offline payment audits it and tells the customer it was not completed', async () => {
    const h = build({ snap: recordedOffline() });
    h.actors.resolve.mockResolvedValue(finance('finance-2'));
    h.tx.payment.findUnique.mockResolvedValue(offlineRow());
    h.tx.payment.findUniqueOrThrow.mockResolvedValue(
      offlineRow({ status: 'failed' }),
    );

    await h.service.rejectOffline(
      'finance-2',
      'payment-1',
      'Not on the statement.',
    );

    expect(rowOf(h.effects, 'Offline payment rejected')).toMatchObject({
      note: 'Not on the statement.',
      changes: {
        before: { status: 'recorded' },
        after: { status: 'failed' },
      },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'payment.failed_customer',
        params: { requestCode: 'XPR-00042' },
      },
    ]);
  });

  it('closing an unpaid Paystack attempt after 30 minutes audits it and tells the customer', async () => {
    const attempt = {
      id: 'payment-1',
      requestId: 'request-1',
      quoteId: 'quote-1',
      reference: 'xpro_1',
      amount: 500_000n,
      method: 'paystack',
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 45 * minutes),
    };
    const h = build({
      prisma: { payment: { findUnique: jest.fn().mockResolvedValue(attempt) } },
      gateway: {
        verify: jest.fn().mockResolvedValue({
          status: 'abandoned',
          reference: 'xpro_1',
          amount: 500_000,
          currency: 'NGN',
        }),
      },
    });

    await expect(h.service.recheckPending('payment-1')).resolves.toBe('failed');

    expect(
      rowOf(h.effects, 'Payment attempt closed (no charge)'),
    ).toMatchObject({
      resourceType: 'payment',
      resourceId: 'payment-1',
      changes: { before: { status: 'pending' }, after: { status: 'failed' } },
    });
    expect(h.effects.notify.map(({ event }) => event)).toEqual([
      'payment.failed_customer',
    ]);
  });

  it('a failed checkout start is audited but does not send a notice', async () => {
    const h = build({
      gateway: { initialize: jest.fn().mockRejectedValue(new Error('down')) },
    });
    h.actors.resolve.mockResolvedValue(customerActor());

    await expect(
      h.service.initiate(
        { id: 'customer-1' } as unknown as RequestUser,
        'XPR-00042',
        'key-1',
        '/requests/XPR-00042/payments',
      ),
    ).rejects.toThrow('down');

    expect(
      h.runs.some(({ command }) => command === 'payment.attemptFailed'),
    ).toBe(true);
    expect(h.effects.notify).toEqual([]);
    expect(h.effects.audit.map(({ action }) => action)).toContain(
      'Payment initialization failed',
    );
  });

  it('settling a Paystack charge writes one system row in the shared audit shape', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn() },
    };
    const h = build({
      prisma: {
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      },
    });

    await h.service.settleCharge(
      {
        id: 'payment-1',
        requestId: 'request-1',
        quoteId: 'quote-1',
        status: 'pending',
      },
      { status: 'success', reference: 'xpro_1' } as VerifiedTransaction,
      { source: 'webhook' },
    );

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: 'system',
        entityType: 'payment',
        entityId: 'payment-1',
        action: 'Payment settled',
        metadata: {
          requestId: 'request-1',
          command: 'payment.settle',
          resourceType: 'payment',
          resourceId: 'payment-1',
          changes: {
            reference: 'xpro_1',
            source: 'webhook',
            before: { status: 'pending' },
            after: { status: 'paid' },
          },
        },
      },
    });
  });

  it('quarantining writes the reason as the note and never the raw gateway body', async () => {
    const tx = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({ number: 42 }),
      },
    };
    const h = build({
      prisma: {
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      },
    });

    await h.service.quarantine({
      payment: {
        id: 'payment-1',
        requestId: 'request-1',
        reference: 'xpro_1',
        quoteId: 'quote-1',
      },
      reference: 'xpro_1',
      reason: 'The transaction amount differs.',
    });

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: 'system',
        entityType: 'payment',
        entityId: 'payment-1',
        action: 'Payment quarantined',
        metadata: {
          requestId: 'request-1',
          command: 'payment.quarantine',
          resourceType: 'payment',
          resourceId: 'payment-1',
          note: 'The transaction amount differs.',
          changes: {
            reference: 'xpro_1',
            before: { quarantined: false },
            after: { quarantined: true },
          },
        },
      },
    });
  });
});
