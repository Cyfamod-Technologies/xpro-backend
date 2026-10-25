import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { JobsService } from '../jobs/jobs.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { ActorService } from '../platform/actor/actor.service';
import type { ActorContext } from '../platform/actor/actor.types';
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
import { createUser, deleteTestUsers } from '../../test/integration/users';
import { PAYMENT_GATEWAY } from './payments.service';
import { RefundsService } from './refunds.service';

/**
 * Refund commands against a real database (05 §6.4, §7; plan C.4). Authored
 * under FX-3.5 and not run there; Phase 12 runs them against the test
 * database.
 */
describe('refund commands (integration)', () => {
  let prisma: PrismaService;
  let refunds: RefundsService;
  const actors = new Map<string, ActorContext>();
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const gateway = {
    refund: jest.fn(),
    verifyRefund: jest.fn(),
    listRefunds: jest.fn().mockResolvedValue([]),
  };
  const createdRequests: string[] = [];

  const staffActor = (userId: string, superAdmin = false): ActorContext =>
    ({
      userId,
      kind: 'staff',
      displayName: 'Finance',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(['refund.manage']),
        canOwn: false,
        isSuperAdmin: superAdmin,
        permVersion: 1,
      },
    }) as unknown as ActorContext;

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
        RefundsService,
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        { provide: UploadsService, useValue: { attach: jest.fn() } },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        { provide: SettingsService, useValue: { snapshot: () => [] } },
        { provide: IdempotencyService, useValue: {} },
        { provide: NotificationDispatcher, useValue: { dispatch } },
        { provide: OutboxService, useValue: { kick: jest.fn() } },
        {
          provide: ActorService,
          useValue: {
            resolve: (userId: string) => Promise.resolve(actors.get(userId)),
          },
        },
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    refunds = moduleRef.get(RefundsService);
  });

  beforeEach(() => {
    gateway.refund.mockReset();
    gateway.refund.mockImplementation(() =>
      Promise.resolve({ id: `gw-${randomUUID()}`, status: 'pending' }),
    );
    dispatch.mockClear();
  });

  afterEach(async () => {
    for (const requestId of createdRequests.splice(0)) {
      await prisma.requestTimer.deleteMany({ where: { requestId } });
      await prisma.approvalDeadline.deleteMany({ where: { requestId } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { entityId: requestId },
            { metadata: { path: ['requestId'], equals: requestId } },
          ],
        },
      });
      await prisma.refund.deleteMany({ where: { requestId } });
      await prisma.payment.deleteMany({ where: { requestId } });
      await prisma.assignment.deleteMany({ where: { requestId } });
      await prisma.serviceRequest.updateMany({
        where: { id: requestId },
        data: { cancellationId: null },
      });
      await prisma.cancellation.deleteMany({ where: { requestId } });
      await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
    }
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  async function staff(superAdmin = false) {
    const user = await createUser(prisma);
    actors.set(user.id, staffActor(user.id, superAdmin));
    return user.id;
  }

  /** A `cancelling` request whose cancellation was approved, with one paid payment per amount and one pending refund for each. */
  async function seedCancelling(options: {
    requestedBy: string;
    payments: Array<{ amount: bigint; method?: 'paystack' | 'offline' }>;
    workStarted?: boolean;
    withAssignment?: boolean;
  }) {
    const owner = await createUser(prisma);
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: owner.id,
        customerName: 'Refund customer',
        title: 'Refund test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for refunds.',
        status: 'cancelling',
      },
    });
    createdRequests.push(request.id);
    const cancellation = await prisma.cancellation.create({
      data: {
        requestId: request.id,
        status: 'approved',
        requestedBy: 'customer',
        requestedById: owner.id,
        reasonCode: 'customer_changed_mind',
        note: 'Changed my mind.',
        stage: 'ready_to_schedule',
        workStarted: options.workStarted ?? false,
        paid: true,
        refundDue: true,
      },
    });
    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { cancellationId: cancellation.id },
    });
    if (options.withAssignment)
      await prisma.assignment.create({
        data: {
          requestId: request.id,
          providerId: randomUUID(),
          providerUserId: randomUUID(),
          status: 'accepted',
          source: 'manual',
          offeredAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
          workStarted: options.workStarted ?? false,
        },
      });
    const paymentIds: string[] = [];
    const refundIds: string[] = [];
    for (const spec of options.payments) {
      const payment = await prisma.payment.create({
        data: {
          requestId: request.id,
          quoteId: randomUUID(),
          quoteVersion: 1,
          amount: spec.amount,
          method: spec.method ?? 'paystack',
          status: 'paid',
          reference: `xpro_${randomUUID().replaceAll('-', '')}`,
          paidAt: new Date(),
        },
      });
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          requestId: request.id,
          cancellationId: cancellation.id,
          amount: spec.amount,
          status: 'pending_approval',
          reason: 'Cancellation refund review.',
          requestedBy: options.requestedBy,
        },
      });
      paymentIds.push(payment.id);
      refundIds.push(refund.id);
    }
    return {
      requestId: request.id,
      cancellationId: cancellation.id,
      paymentIds,
      refundIds,
    };
  }

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ ok: true as const }),
      (error: { status?: number }) => ({
        ok: false as const,
        status: error.status,
      }),
    );

  it('two concurrent decisions on one refund call the gateway once and refund once (C-09)', async () => {
    const requester = await staff();
    const deciderA = await staff();
    const deciderB = await staff();
    const seeded = await seedCancelling({
      requestedBy: requester,
      payments: [{ amount: 500_000n }],
    });

    const results = await Promise.all([
      outcome(
        refunds.decide(deciderA, seeded.refundIds[0], {
          approve: true,
          reason: 'Approved by A.',
        }),
      ),
      outcome(
        refunds.decide(deciderB, seeded.refundIds[0], {
          approve: true,
          reason: 'Approved by B.',
        }),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ status: 409 });
    expect(gateway.refund).toHaveBeenCalledTimes(1);
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { id: seeded.refundIds[0] },
    });
    expect(refund.status).toBe('processing');
    expect(refund.gatewayRefundId).toMatch(/^gw-/);
  });

  it('two refunds of one payment cannot together refund more than was paid (C-09)', async () => {
    const requester = await staff();
    const deciderA = await staff();
    const deciderB = await staff();
    const seeded = await seedCancelling({
      requestedBy: requester,
      payments: [{ amount: 500_000n }],
    });
    // A staff-requested refund of 300 000 on the same payment, and the cancellation refund edited to 300 000.
    await prisma.refund.update({
      where: { id: seeded.refundIds[0] },
      data: { cancellationId: null, amount: 300_000n },
    });
    const second = await prisma.refund.create({
      data: {
        paymentId: seeded.paymentIds[0],
        requestId: seeded.requestId,
        amount: 300_000n,
        status: 'pending_approval',
        reason: 'Goodwill.',
        requestedBy: requester,
      },
    });

    const results = await Promise.all([
      outcome(
        refunds.decide(deciderA, seeded.refundIds[0], {
          approve: true,
          reason: 'First.',
        }),
      ),
      outcome(
        refunds.decide(deciderB, second.id, {
          approve: true,
          reason: 'Second.',
        }),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ status: 422 });
    expect(gateway.refund).toHaveBeenCalledTimes(1);
  });

  it('after work started, a zero refund waits for a Super admin and then resolves the cancellation as waived (C-07)', async () => {
    const requester = await staff();
    const decider = await staff();
    const admin = await staff(true);
    const seeded = await seedCancelling({
      requestedBy: requester,
      payments: [{ amount: 500_000n }],
      workStarted: true,
      withAssignment: true,
    });

    await refunds.decide(decider, seeded.refundIds[0], {
      approve: true,
      amount: 0,
      reason: 'The job was finished before the cancellation.',
    });
    expect(
      (
        await prisma.refund.findUniqueOrThrow({
          where: { id: seeded.refundIds[0] },
        })
      ).status,
    ).toBe('awaiting_second_approval');
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: seeded.requestId },
        })
      ).status,
    ).toBe('cancelling');

    await refunds.secondApprove(admin, seeded.refundIds[0], {
      approve: true,
      reason: 'Agreed.',
    });

    expect(
      (
        await prisma.refund.findUniqueOrThrow({
          where: { id: seeded.refundIds[0] },
        })
      ).status,
    ).toBe('waived');
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: seeded.requestId },
        })
      ).status,
    ).toBe('cancelled');
    expect(gateway.refund).not.toHaveBeenCalled();
  });

  it('cancelling becomes cancelled only when every refund of the cancellation is resolved', async () => {
    const requester = await staff();
    const decider = await staff();
    const reconciler = await staff();
    const seeded = await seedCancelling({
      requestedBy: requester,
      payments: [
        { amount: 500_000n, method: 'offline' },
        { amount: 200_000n, method: 'offline' },
      ],
      withAssignment: true,
    });
    for (const id of seeded.refundIds) {
      await refunds.decide(decider, id, {
        approve: true,
        reason: 'Full refund before work.',
      });
      await prisma.refund.update({
        where: { id },
        data: {
          status: 'processing',
          transferReference: `BANK-${id}`,
          transferRecordedBy: decider,
        },
      });
    }

    await refunds.reconcile(
      reconciler,
      seeded.refundIds[0],
      'Seen on the statement.',
    );

    const midway = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: seeded.requestId },
    });
    expect(midway.status).toBe('cancelling');
    expect(
      (
        await prisma.cancellation.findUniqueOrThrow({
          where: { id: seeded.cancellationId },
        })
      ).status,
    ).toBe('approved');

    await refunds.reconcile(
      reconciler,
      seeded.refundIds[1],
      'Seen on the statement.',
    );

    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: seeded.requestId },
        })
      ).status,
    ).toBe('cancelled');
    expect(
      (
        await prisma.cancellation.findUniqueOrThrow({
          where: { id: seeded.cancellationId },
        })
      ).status,
    ).toBe('completed');
    const assignment = await prisma.assignment.findFirstOrThrow({
      where: { requestId: seeded.requestId },
    });
    expect(assignment).toMatchObject({
      status: 'withdrawn',
      endReason: 'request_cancelled',
    });
    expect(
      await prisma.approvalDeadline.count({
        where: { requestId: seeded.requestId, closedAt: null },
      }),
    ).toBe(0);
    expect(
      dispatch.mock.calls.filter(
        ([, event]) => event === 'cancellation.completed_customer',
      ),
    ).toHaveLength(1);
  });

  it('a rejected refund keeps the request cancelling until a replacement completes', async () => {
    const requester = await staff();
    const decider = await staff();
    const reconciler = await staff();
    const seeded = await seedCancelling({
      requestedBy: requester,
      payments: [{ amount: 500_000n, method: 'offline' }],
    });

    await refunds.decide(decider, seeded.refundIds[0], {
      approve: false,
      reason: 'Wrong details.',
    });
    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: seeded.requestId },
        })
      ).status,
    ).toBe('cancelling');
    expect(
      await prisma.approvalDeadline.count({
        where: { requestId: seeded.requestId, kind: 'refund', closedAt: null },
      }),
    ).toBe(1);

    const replacement = await refunds.request(requester, seeded.paymentIds[0], {
      reason: 'Replace the rejected refund.',
    });
    await refunds.decide(decider, replacement.id, {
      approve: true,
      reason: 'Full refund before work.',
    });
    await prisma.refund.update({
      where: { id: replacement.id },
      data: {
        status: 'processing',
        transferReference: 'BANK-1',
        transferRecordedBy: decider,
      },
    });
    await refunds.reconcile(
      reconciler,
      replacement.id,
      'Seen on the statement.',
    );

    expect(
      (
        await prisma.serviceRequest.findUniqueOrThrow({
          where: { id: seeded.requestId },
        })
      ).status,
    ).toBe('cancelled');
  });
});
