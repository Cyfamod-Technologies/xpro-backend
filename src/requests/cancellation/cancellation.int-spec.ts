import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import {
  PAYMENT_GATEWAY,
  PaymentsService,
} from '../../payments/payments.service';
import { ActorService } from '../../platform/actor/actor.service';
import type { ActorContext } from '../../platform/actor/actor.types';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { TimersService } from '../../platform/timers/timers.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../../uploads/uploads.service';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import type { RequestUser } from '../../common/types/request-user';
import { ApprovalsHooks } from '../approvals.hooks';
import { RequestCommandRunner } from '../command-runner';
import { RequestEventsService } from '../events/request-events.service';
import { IntakeService } from '../intake.service';
import { RequestSnapshotLoader } from '../snapshot.loader';
import { CancellationService } from './cancellation.service';

/**
 * Cancellation at four stages against a real database (04 §5.2 #6, #12, #24,
 * §6.21; plan WP-8.4 done-when). Authored under FX-3.11 and not run there;
 * Phase 12 runs it against the test database.
 */
describe('cancellation at every stage (integration)', () => {
  let prisma: PrismaService;
  let cancellation: CancellationService;
  const actors = new Map<string, ActorContext>();
  const createdRequests: string[] = [];
  const dispatch = jest.fn().mockResolvedValue(undefined);

  const customerActor = (userId: string) =>
    ({
      userId,
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    }) as unknown as ActorContext;

  const staffActor = (userId: string, ...permissions: string[]) =>
    ({
      userId,
      kind: 'staff',
      displayName: 'Ops',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(permissions),
        canOwn: false,
        isSuperAdmin: false,
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
        PaymentsService,
        IntakeService,
        CancellationService,
        { provide: PAYMENT_GATEWAY, useValue: {} },
        { provide: UploadsService, useValue: { attach: jest.fn() } },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        { provide: SettingsService, useValue: { snapshot: () => [] } },
        {
          provide: IdempotencyService,
          useValue: { hashRequest: () => 'hash' },
        },
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
    cancellation = moduleRef.get(CancellationService);
  });

  afterEach(async () => {
    dispatch.mockClear();
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
      await prisma.schedule.deleteMany({ where: { requestId } });
      await prisma.progressUpdate.deleteMany({ where: { requestId } });
      await prisma.issue.deleteMany({ where: { requestId } });
      await prisma.assignment.deleteMany({ where: { requestId } });
      await prisma.quote.deleteMany({ where: { requestId } });
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

  const asUser = (id: string) => ({ id }) as RequestUser;
  const body = { note: 'No longer needed', reasonCode: 'duplicate' };

  async function customer() {
    const user = await createUser(prisma);
    actors.set(user.id, customerActor(user.id));
    return user.id;
  }

  async function staff(...permissions: string[]) {
    const user = await createUser(prisma);
    actors.set(user.id, staffActor(user.id, ...permissions));
    return user.id;
  }

  async function seedRequest(
    ownerId: string,
    status:
      | 'submitted'
      | 'quoted'
      | 'scheduled'
      | 'in_progress'
      | 'completion_pending',
  ) {
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId,
        customerName: 'Cancellation customer',
        title: 'Cancellation test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for cancellation.',
        status,
        intakeState: status === 'submitted' ? 'pending' : 'approved',
      },
    });
    createdRequests.push(request.id);
    return request.id;
  }

  const seedAssignment = (
    requestId: string,
    options: {
      status: 'offered' | 'accepted';
      workStarted?: boolean;
    },
  ) =>
    prisma.assignment.create({
      data: {
        requestId,
        providerId: randomUUID(),
        providerUserId: randomUUID(),
        status: options.status,
        source: 'manual',
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        workStarted: options.workStarted ?? false,
      },
    });

  async function seedPaidQuote(requestId: string) {
    const quote = await prisma.quote.create({
      data: {
        requestId,
        version: 1,
        status: 'accepted',
        items: [],
        total: 500_000n,
        lastEditedBy: randomUUID(),
        acceptedAt: new Date(),
      },
    });
    await prisma.payment.create({
      data: {
        requestId,
        quoteId: quote.id,
        quoteVersion: 1,
        amount: 500_000n,
        method: 'paystack',
        status: 'paid',
        reference: `xpro_${randomUUID().replaceAll('-', '')}`,
        paidAt: new Date(Date.now() - 3_600_000),
      },
    });
    return quote.id;
  }

  const reload = (requestId: string) =>
    prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });

  it('submitted: the owner cancels for free and no cancellation request is created', async () => {
    const owner = await customer();
    const requestId = await seedRequest(owner, 'submitted');

    await cancellation.cancel(
      asUser(owner),
      requestId,
      { note: 'Changed my mind' },
      undefined,
      '/requests/cancel',
    );

    expect((await reload(requestId)).status).toBe('cancelled');
    const rows = await prisma.cancellation.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'completed',
      requestedBy: 'customer',
      reasonCode: 'customer_changed_mind',
    });
  });

  it('quoted: a customer request waits for staff, then the approval cancels the request in one step', async () => {
    const owner = await customer();
    const ops = await staff('request.cancel');
    const requestId = await seedRequest(owner, 'quoted');
    const offer = await seedAssignment(requestId, { status: 'offered' });

    await cancellation.cancel(
      asUser(owner),
      requestId,
      { note: 'Quote is too high' },
      undefined,
      '/requests/cancel',
    );

    const pending = await prisma.cancellation.findFirstOrThrow({
      where: { requestId },
    });
    expect(pending).toMatchObject({
      status: 'pending',
      reasonCode: 'customer_changed_mind',
      paid: false,
      workStarted: false,
      stage: 'quoted',
    });
    expect((await reload(requestId)).status).toBe('quoted');
    expect(
      await prisma.requestTimer.count({
        where: { requestId, kind: 'T19.followup', status: 'pending' },
      }),
    ).toBe(1);

    await cancellation.decide(
      ops,
      requestId,
      { approve: true, note: 'Agreed' },
      undefined,
      '/requests/cancellation/decide',
    );

    const request = await reload(requestId);
    expect(request).toMatchObject({
      status: 'cancelled',
      cancellationId: pending.id,
    });
    expect(
      await prisma.cancellation.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    ).toMatchObject({ status: 'completed', decidedBy: ops, refundDue: false });
    expect(
      await prisma.assignment.findUniqueOrThrow({ where: { id: offer.id } }),
    ).toMatchObject({ status: 'withdrawn', endReason: 'request_cancelled' });
    expect(
      await prisma.requestTimer.count({
        where: { requestId, status: 'pending' },
      }),
    ).toBe(0);
  });

  it('scheduled and paid: the approval needs request.cancel.active, moves to cancelling and opens the refund', async () => {
    const owner = await customer();
    const ops = await staff('request.cancel');
    const active = await staff('request.cancel', 'request.cancel.active');
    const requestId = await seedRequest(owner, 'scheduled');
    const quoteId = await seedPaidQuote(requestId);
    const assignment = await seedAssignment(requestId, { status: 'accepted' });
    const schedule = await prisma.schedule.create({
      data: {
        requestId,
        assignmentId: assignment.id,
        providerId: assignment.providerId,
        quoteId,
        startAt: new Date(Date.now() + 2 * 86_400_000),
        endAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        status: 'confirmed',
        customer: 'accepted',
        provider: 'accepted',
        proposedBy: ops,
        proposedAt: new Date(),
      },
    });

    await cancellation.cancel(
      asUser(owner),
      requestId,
      { note: 'Plans changed', reasonCode: 'other' },
      undefined,
      '/requests/cancel',
    );
    const pending = await prisma.cancellation.findFirstOrThrow({
      where: { requestId },
    });
    expect(pending).toMatchObject({ paid: true, reasonCode: 'other' });

    await expect(
      cancellation.decide(
        ops,
        requestId,
        { approve: true },
        undefined,
        '/requests/cancellation/decide',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await reload(requestId)).status).toBe('scheduled');

    await cancellation.decide(
      active,
      requestId,
      { approve: true },
      undefined,
      '/requests/cancellation/decide',
    );

    expect(await reload(requestId)).toMatchObject({
      status: 'cancelling',
      cancellationId: pending.id,
    });
    expect(
      await prisma.cancellation.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    ).toMatchObject({ status: 'approved', refundDue: true, paid: true });
    const refunds = await prisma.refund.findMany({ where: { requestId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      status: 'pending_approval',
      cancellationId: pending.id,
      amount: 500_000n,
    });
    expect(
      await prisma.assignment.findUniqueOrThrow({
        where: { id: assignment.id },
      }),
    ).toMatchObject({ status: 'withdrawn', endReason: 'request_cancelled' });
    expect(
      (await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } }))
        .status,
    ).toBe('cancelled');
  });

  it('in progress: work started needs request.cancel.active and the cleanup leaves nothing behind', async () => {
    const owner = await customer();
    const ops = await staff('request.cancel');
    const active = await staff('request.cancel', 'request.cancel.active');
    const requestId = await seedRequest(owner, 'in_progress');
    await seedPaidQuote(requestId);
    const assignment = await seedAssignment(requestId, {
      status: 'accepted',
      workStarted: true,
    });
    await prisma.serviceRequest.update({
      where: { id: requestId },
      data: {
        holdKind: 'staff',
        holdBy: ops,
        holdReason: 'Waiting for access',
        holdAt: new Date(),
        holdPreviousStatus: 'in_progress',
      },
    });
    const update = await prisma.progressUpdate.create({
      data: {
        requestId,
        assignmentId: assignment.id,
        authorId: assignment.providerUserId,
        kind: 'progress',
        target: 'in_progress',
        note: 'Half done',
      },
    });
    const issue = await prisma.issue.create({
      data: {
        requestId,
        window: 'completion',
        note: 'Tiles are cracked',
        raisedBy: owner,
        raisedAt: new Date(),
        cycle: 1,
      },
    });

    // A staff member without the active permission cannot cancel a started job directly.
    await expect(
      cancellation.cancel(
        asUser(ops),
        requestId,
        body,
        undefined,
        '/requests/cancel',
      ),
    ).rejects.toMatchObject({ status: 403 });

    await cancellation.cancel(
      asUser(active),
      requestId,
      body,
      undefined,
      '/requests/cancel',
    );

    expect(await reload(requestId)).toMatchObject({
      status: 'cancelling',
      holdKind: null,
      holdPreviousStatus: null,
    });
    const row = await prisma.cancellation.findFirstOrThrow({
      where: { requestId },
    });
    expect(row).toMatchObject({
      requestedBy: 'staff',
      reasonCode: 'duplicate',
      status: 'approved',
      paid: true,
      workStarted: true,
      compensationCandidateIds: [assignment.id],
    });
    expect(
      await prisma.assignment.findUniqueOrThrow({
        where: { id: assignment.id },
      }),
    ).toMatchObject({
      status: 'withdrawn',
      endReason: 'request_cancelled',
      workStarted: true,
    });
    expect(
      await prisma.progressUpdate.findUniqueOrThrow({
        where: { id: update.id },
      }),
    ).toMatchObject({ state: 'rejected', systemReason: 'assignment_ended' });
    expect(
      await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } }),
    ).toMatchObject({ status: 'resolved', resolvedWith: 'no_rework' });
    expect(await prisma.refund.count({ where: { requestId } })).toBe(1);
  });

  it('a pending customer cancellation is rejected on completion_pending and T17 is started again', async () => {
    const owner = await customer();
    const active = await staff('request.cancel', 'request.cancel.active');
    const requestId = await seedRequest(owner, 'completion_pending');
    await seedPaidQuote(requestId);
    await seedAssignment(requestId, { status: 'accepted', workStarted: true });
    const dueAt = new Date(Date.now() + 3_600_000);
    await prisma.serviceRequest.update({
      where: { id: requestId },
      data: {
        reportApprovedAt: new Date(Date.now() - 71 * 3_600_000),
        confirmDueAt: dueAt,
      },
    });

    await cancellation.cancel(
      asUser(owner),
      requestId,
      { note: 'Not what I asked for' },
      undefined,
      '/requests/cancel',
    );
    await cancellation.decide(
      active,
      requestId,
      { approve: false, note: 'The work is complete.' },
      undefined,
      '/requests/cancellation/decide',
    );

    expect((await reload(requestId)).status).toBe('completion_pending');
    const timer = await prisma.requestTimer.findFirstOrThrow({
      where: { requestId, kind: 'T17.autoConfirm', status: 'pending' },
    });
    expect(timer.dueAt.getTime()).toBe(dueAt.getTime());
  });
});
