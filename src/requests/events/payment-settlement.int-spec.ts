import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { JobsService } from '../../jobs/jobs.service';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { TimersService } from '../../platform/timers/timers.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsHooks } from '../approvals.hooks';
import { RequestCommandRunner } from '../command-runner';
import { RequestSnapshotLoader } from '../snapshot.loader';
import { RequestEventsService } from './request-events.service';

describe('payment settlement atomicity (integration)', () => {
  let prisma: PrismaService;
  let events: RequestEventsService;
  let timers: TimersService;
  let requestId: string;
  let quoteId: string;
  let paymentId: string;
  const dispatch = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RequestSnapshotLoader,
        RequestCommandRunner,
        RequestEventsService,
        ApprovalsHooks,
        TimersService,
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        { provide: SettingsService, useValue: { snapshot: () => [] } },
        { provide: IdempotencyService, useValue: {} },
        { provide: NotificationDispatcher, useValue: { dispatch } },
        { provide: OutboxService, useValue: { kick: jest.fn() } },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(RequestEventsService);
    timers = moduleRef.get(TimersService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seed(status: 'awaiting_payment' | 'matched') {
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: randomUUID(),
        customerName: 'Settlement customer',
        title: 'Settlement test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for payment settlement.',
        status,
      },
    });
    requestId = request.id;
    const quote = await prisma.quote.create({
      data: {
        requestId,
        version: 1,
        status: 'accepted',
        items: [],
        total: 500_000n,
        lastEditedBy: randomUUID(),
      },
    });
    quoteId = quote.id;
    const payment = await prisma.payment.create({
      data: {
        requestId,
        quoteId,
        quoteVersion: 1,
        amount: 500_000n,
        method: 'offline',
        status: 'recorded',
        reference: `ref-${randomUUID()}`,
      },
    });
    paymentId = payment.id;
    await prisma.$transaction((tx) =>
      timers.start(tx, {
        requestId,
        kind: 'T9.lapse',
        dueAt: new Date(Date.now() + 86_400_000),
        refId: quoteId,
      }),
    );
  }

  afterEach(async () => {
    dispatch.mockClear();
    await prisma.requestTimer.deleteMany({ where: { requestId } });
    await prisma.auditLog.deleteMany({ where: { entityId: requestId } });
    await prisma.refund.deleteMany({ where: { requestId } });
    await prisma.payment.deleteMany({ where: { requestId } });
    await prisma.quote.deleteMany({ where: { requestId } });
    await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
  });

  const markPaid = (
    tx: Parameters<RequestEventsService['onPaymentSettled']>[0],
  ) =>
    tx.payment.update({
      where: { id: paymentId },
      data: { status: 'paid', paidAt: new Date() },
    });

  it('commits the paid payment and the ready_to_schedule request together', async () => {
    await seed('awaiting_payment');
    const before = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    const { afterCommit } = await prisma.$transaction(async (tx) => {
      await markPaid(tx);
      return events.onPaymentSettled(tx, requestId, quoteId, paymentId);
    });
    await afterCommit();

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    const request = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(payment.status).toBe('paid');
    expect(request.status).toBe('ready_to_schedule');
    expect(request.version).toBe(before.version + 1);
    const audit = await prisma.auditLog.findMany({
      where: { entityId: requestId, action: 'Request paid' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      requestId,
      command: 'payment.settled',
    });
    const pendingTimers = await prisma.requestTimer.count({
      where: { requestId, status: 'pending' },
    });
    expect(pendingTimers).toBe(0);
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'payment.settled_customer',
      expect.objectContaining({
        requestCode: expect.stringMatching(/^XPR-/) as unknown,
      }),
      expect.objectContaining({ requestId }),
    );
  });

  it('rolls back the payment and the request when the transaction fails after settlement', async () => {
    await seed('awaiting_payment');
    const before = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await markPaid(tx);
        await events.onPaymentSettled(tx, requestId, quoteId, paymentId);
        throw new Error('simulated failure after settlement');
      }),
    ).rejects.toThrow('simulated failure after settlement');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    const request = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(payment.status).toBe('recorded');
    expect(request.status).toBe('awaiting_payment');
    expect(request.version).toBe(before.version);
    expect(
      await prisma.auditLog.count({
        where: { entityId: requestId, action: 'Request paid' },
      }),
    ).toBe(0);
    expect(
      await prisma.requestTimer.count({
        where: { requestId, status: 'pending' },
      }),
    ).toBe(1);
  });

  it('leaves the request alone and opens one full refund for a late payment', async () => {
    await seed('matched');

    await prisma.$transaction(async (tx) => {
      await markPaid(tx);
      await events.onPaymentSettled(tx, requestId, quoteId, paymentId);
    });

    const request = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(request.status).toBe('matched');
    const refunds = await prisma.refund.findMany({ where: { requestId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount: 500_000n,
      status: 'pending_approval',
    });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
        .lateRefundOpened,
    ).toBe(true);
  });
});
