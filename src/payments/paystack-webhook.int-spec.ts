import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import { JobsService } from '../jobs/jobs.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { ActorService } from '../platform/actor/actor.service';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { SettingsService } from '../platform/settings/settings.service';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { TimersService } from '../platform/timers/timers.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsHooks } from '../requests/approvals.hooks';
import { RequestCommandRunner } from '../requests/command-runner';
import { RequestEventsService } from '../requests/events/request-events.service';
import { RequestSnapshotLoader } from '../requests/snapshot.loader';
import { UploadsService } from '../uploads/uploads.service';
import { GatewayInboxService } from './gateway-inbox.service';
import { GATEWAY_EVENT_BACKOFF_MS } from './domain/webhook-reclaim';
import type { VerifiedTransaction } from './payment-gateway';
import { PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { PaystackEventsService } from './paystack-events.service';

const SECRET = 'sk_test_webhook_secret';

/**
 * Webhook-to-settlement flows against a real database: duplicate,
 * out-of-order, failed-then-retried and mismatched events, and settlement
 * atomic with the request transition (05 §6.2, §7, §8).
 */
describe('Paystack webhook settlement (integration)', () => {
  let prisma: PrismaService;
  let events: PaystackEventsService;
  let inbox: GatewayInboxService;
  let requestEvents: RequestEventsService;
  let ownerId: string;
  let requestId: string;
  let quoteId: string;
  let paymentId: string;
  let reference: string;
  const verify = jest.fn<Promise<VerifiedTransaction>, [string]>();
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const dispatchAlert = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RequestSnapshotLoader,
        RequestCommandRunner,
        RequestEventsService,
        ApprovalsHooks,
        TimersService,
        TimerRegistry,
        PaymentsService,
        GatewayInboxService,
        PaystackEventsService,
        { provide: PAYMENT_GATEWAY, useValue: { verify } },
        { provide: ConfigService, useValue: { get: () => SECRET } },
        { provide: ActorService, useValue: {} },
        { provide: UploadsService, useValue: {} },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        { provide: SettingsService, useValue: { snapshot: () => [] } },
        { provide: IdempotencyService, useValue: {} },
        {
          provide: NotificationDispatcher,
          useValue: { dispatch, dispatchAlert },
        },
        { provide: OutboxService, useValue: { kick: jest.fn() } },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(PaystackEventsService);
    inbox = moduleRef.get(GatewayInboxService);
    requestEvents = moduleRef.get(RequestEventsService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seed(
    status: 'awaiting_payment' | 'matched' = 'awaiting_payment',
  ) {
    ownerId = randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `owner-${ownerId}@example.com`,
        firstName: 'Owner',
        lastName: 'Test',
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId,
        customerName: 'Webhook customer',
        title: 'Webhook test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for the Paystack webhook.',
        status,
      },
    });
    requestId = request.id;
    const quote = await prisma.quote.create({
      data: {
        requestId,
        version: 1,
        status: status === 'awaiting_payment' ? 'accepted' : 'expired',
        items: [],
        total: 500_000n,
        lastEditedBy: randomUUID(),
      },
    });
    quoteId = quote.id;
    reference = `xpro_${randomUUID().replaceAll('-', '')}`;
    const payment = await prisma.payment.create({
      data: {
        requestId,
        quoteId,
        quoteVersion: 1,
        amount: 500_000n,
        method: 'paystack',
        status: 'pending',
        reference,
      },
    });
    paymentId = payment.id;
  }

  const verifiedTransaction = (
    overrides: Partial<VerifiedTransaction> = {},
  ): VerifiedTransaction => ({
    status: 'success',
    reference,
    amount: 500_000,
    currency: 'NGN',
    customer: { email: `owner-${ownerId}@example.com` },
    metadata: { paymentId, requestId, quoteId },
    ...overrides,
  });

  const deliver = (extra: Record<string, unknown> = {}) => {
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'charge.success',
        data: { reference, ...extra },
      }),
    );
    const signature = createHmac('sha512', SECRET)
      .update(rawBody)
      .digest('hex');
    return events.handleWebhook(rawBody, signature);
  };

  beforeEach(() => {
    verify.mockReset();
    dispatch.mockClear();
    dispatchAlert.mockClear();
  });

  afterEach(async () => {
    await prisma.gatewayEvent.deleteMany({ where: { reference } });
    await prisma.requestTimer.deleteMany({ where: { requestId } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: requestId }, { entityId: paymentId }] },
    });
    await prisma.approvalDeadline.deleteMany({ where: { requestId } });
    await prisma.refund.deleteMany({ where: { requestId } });
    await prisma.payment.deleteMany({ where: { requestId } });
    await prisma.quote.deleteMany({ where: { requestId } });
    await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('settles once: the same signed body twice gives one paid payment, one transition and one receipt', async () => {
    await seed();
    verify.mockResolvedValue(verifiedTransaction());

    const first = await deliver();
    const second = await deliver();

    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(second).toMatchObject({ accepted: true, duplicate: true });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('paid');
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).status,
    ).toBe('ready_to_schedule');
    expect(
      await prisma.auditLog.count({
        where: { entityId: requestId, action: 'Request paid' },
      }),
    ).toBe(1);
    expect(
      dispatch.mock.calls.filter(
        ([, event]) => event === 'payment.settled_customer',
      ),
    ).toHaveLength(1);
    expect(
      await prisma.approvalDeadline.count({
        where: { requestId, kind: 'schedule_needed', closedAt: null },
      }),
    ).toBe(1);
  });

  it('a differently-bodied second charge.success for a paid reference has no effect (out of order)', async () => {
    await seed();
    verify.mockResolvedValue(verifiedTransaction());

    await deliver({ id: 1 });
    const second = await deliver({ id: 2 });

    expect(second).toMatchObject({ accepted: true, duplicate: true });
    expect(
      await prisma.auditLog.count({
        where: { entityId: requestId, action: 'Request paid' },
      }),
    ).toBe(1);
    expect(await prisma.refund.count({ where: { requestId } })).toBe(0);
  });

  it('records a charge that arrives after the quote lapsed and opens exactly one full refund', async () => {
    await seed('matched');
    verify.mockResolvedValue(verifiedTransaction());

    await deliver({ id: 1 });
    await deliver({ id: 2 });

    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).status,
    ).toBe('matched');
    const refunds = await prisma.refund.findMany({ where: { requestId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount: 500_000n,
      status: 'pending_approval',
    });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('paid');
  });

  it('fails the event when verification times out, then settles on the redelivery', async () => {
    await seed();
    verify.mockRejectedValueOnce(new Error('Paystack timed out'));
    verify.mockResolvedValue(verifiedTransaction());

    await expect(deliver()).rejects.toThrow('Paystack timed out');
    const failed = await prisma.gatewayEvent.findFirstOrThrow({
      where: { reference },
    });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('pending');

    const retry = await deliver();

    expect(retry).toMatchObject({ accepted: true, duplicate: false });
    expect(
      (await prisma.gatewayEvent.findFirstOrThrow({ where: { reference } }))
        .status,
    ).toBe('processed');
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('paid');
  });

  it('retries a failed event from the sweeper once its backoff has passed', async () => {
    await seed();
    verify.mockRejectedValueOnce(new Error('Paystack timed out'));
    verify.mockResolvedValue(verifiedTransaction());
    await expect(deliver()).rejects.toThrow();

    await inbox.sweep(
      (event) => events.process(event),
      new Date(Date.now() + GATEWAY_EVENT_BACKOFF_MS[0] + 1000),
    );

    expect(
      (await prisma.gatewayEvent.findFirstOrThrow({ where: { reference } }))
        .status,
    ).toBe('processed');
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('paid');
  });

  it('quarantines a mismatched transaction: the payment stays pending, the request stays locked, Finance is alerted', async () => {
    await seed();
    verify.mockResolvedValue(verifiedTransaction({ amount: 400_000 }));

    const result = await deliver();

    expect(result).toMatchObject({ accepted: true });
    expect(
      (await prisma.gatewayEvent.findFirstOrThrow({ where: { reference } }))
        .status,
    ).toBe('quarantined');
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('pending');
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).status,
    ).toBe('awaiting_payment');
    expect(dispatchAlert).toHaveBeenCalledWith(
      expect.anything(),
      'payment.quarantined',
      expect.objectContaining({ reference }),
    );
    expect(
      await prisma.auditLog.count({
        where: { entityId: paymentId, action: 'Payment quarantined' },
      }),
    ).toBe(1);
  });

  it('rolls the payment back with the request when the transition fails (settlement is atomic)', async () => {
    await seed();
    verify.mockResolvedValue(verifiedTransaction());
    jest
      .spyOn(requestEvents, 'onPaymentSettled')
      .mockRejectedValueOnce(new Error('request transition failed'));

    await expect(deliver()).rejects.toThrow('request transition failed');

    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('pending');
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).status,
    ).toBe('awaiting_payment');
    expect(
      await prisma.auditLog.count({
        where: { entityId: paymentId, action: 'Payment settled' },
      }),
    ).toBe(0);
    expect(
      (await prisma.gatewayEvent.findFirstOrThrow({ where: { reference } }))
        .status,
    ).toBe('failed');
  });

  it('claims a failed Paystack attempt when a verified charge still arrives', async () => {
    await seed();
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'failed', failureReason: 'Checkout was not completed.' },
    });
    verify.mockResolvedValue(verifiedTransaction());

    await deliver();

    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .status,
    ).toBe('paid');
  });
});
