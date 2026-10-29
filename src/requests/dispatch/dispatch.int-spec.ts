import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { ActorService } from '../../platform/actor/actor.service';
import type { ActorContext } from '../../platform/actor/actor.types';
import { AppError } from '../../platform/errors/app-error';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { TimersService } from '../../platform/timers/timers.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsHooks } from '../approvals.hooks';
import { RequestCommandRunner } from '../command-runner';
import { RequestSnapshotLoader } from '../snapshot.loader';
import { timerFixture } from '../system-command.testkit';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { DispatchTimerHandlers } from './dispatch-timer-handlers';
import { DispatchService } from './dispatch.service';
import { ProviderDispatchLoader } from './provider-dispatch.loader';

/**
 * Integration cases for the dispatch engine (audit B-28). Authored under
 * FX-3.2 and not run there; Phase 12 runs them against the test database.
 */
describe('dispatch engine (integration)', () => {
  let prisma: PrismaService;
  let service: DispatchService;
  let registry: TimerRegistry;
  const dispatch = jest.fn().mockResolvedValue(undefined);
  let staffId = '';
  const actors = new Map<string, ActorContext>();
  const districtId = randomUUID();
  const cityId = randomUUID();
  const createdRequests: string[] = [];

  const staffActor = (userId: string): ActorContext =>
    ({
      userId,
      kind: 'staff',
      displayName: 'Dispatcher',
      platformRoles: [],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(['dispatch.manage']),
        canOwn: false,
        isSuperAdmin: false,
        permVersion: 1,
      },
    }) as unknown as ActorContext;
  const providerActor = (userId: string): ActorContext =>
    ({
      userId,
      kind: 'provider',
      displayName: 'Provider',
      platformRoles: ['provider'],
      accountActive: true,
    }) as unknown as ActorContext;

  beforeAll(async () => {
    registry = new TimerRegistry();
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RequestSnapshotLoader,
        RequestCommandRunner,
        ApprovalsHooks,
        TimersService,
        ProviderDispatchLoader,
        DispatchService,
        { provide: TimerRegistry, useValue: registry },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        {
          provide: SettingsService,
          useValue: {
            snapshot: () => [
              { key: 'assignment.requireVerifiedBank', value: false },
            ],
          },
        },
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
    service = moduleRef.get(DispatchService);
    new DispatchTimerHandlers(
      registry,
      moduleRef.get(RequestCommandRunner),
      moduleRef.get(ProviderDispatchLoader),
    );
    const staff = await createUser(prisma);
    staffId = staff.id;
    actors.set(staffId, staffActor(staffId));
  });

  afterEach(async () => {
    dispatch.mockClear();
    for (const requestId of createdRequests.splice(0)) {
      await prisma.requestTimer.deleteMany({ where: { requestId } });
      await prisma.auditLog.deleteMany({ where: { entityId: requestId } });
      await prisma.payout.deleteMany({ where: { requestId } });
      await prisma.payment.deleteMany({ where: { requestId } });
      await prisma.quote.deleteMany({ where: { requestId } });
      await prisma.dispatchRun.deleteMany({ where: { requestId } });
      await prisma.assignment.deleteMany({ where: { requestId } });
      await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
    }
    await prisma.providerProfile.deleteMany({
      where: { serviceAreaIds: { has: districtId } },
    });
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  async function seedRequest(
    status: 'under_review' | 'ready_to_schedule' | 'matched' = 'under_review',
  ) {
    const owner = await createUser(prisma);
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: owner.id,
        customerName: 'Dispatch customer',
        title: 'Dispatch test',
        service: 'Design',
        cityId,
        districtId,
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for dispatch.',
        details: { designType: 'Architectural plan' },
        status,
        intakeState: 'approved',
        dispatchMode: 'auto',
      },
    });
    createdRequests.push(request.id);
    return request;
  }

  async function seedProvider(
    patch: { capacity?: number; lastOfferedAt?: Date | null } = {},
  ) {
    const user = await createUser(prisma);
    actors.set(user.id, providerActor(user.id));
    const everyDay = { start: '00:00', end: '23:59' };
    return prisma.providerProfile.create({
      data: {
        userId: user.id,
        phone: '+2348000000000',
        trade: 'Architect',
        city: 'Test city',
        services: ['Design'],
        serviceAreas: [],
        serviceAreaIds: [districtId],
        skills: { Design: ['Architectural plan'] },
        capacity: patch.capacity ?? 3,
        lastOfferedAt: patch.lastOfferedAt ?? null,
        workingHours: {
          mon: everyDay,
          tue: everyDay,
          wed: everyDay,
          thu: everyDay,
          fri: everyDay,
          sat: everyDay,
          sun: everyDay,
        },
        bio: 'Integration test provider.',
        verification: 'approved',
        available: true,
      },
    });
  }

  const cascade = (requestId: string) =>
    registry.get('dispatch.cascade')!(
      timerFixture('dispatch.cascade', {
        requestId,
        payload: { trigger: 'intake_approved' },
      }),
    );

  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as AppError;
    }
    throw new Error('Expected the command to be refused.');
  };

  it('auto cascade: offers the best-ranked provider, stores the run and bumps the version', async () => {
    const request = await seedRequest();
    const fresh = await seedProvider();
    await seedProvider({ lastOfferedAt: new Date() });

    await cascade(request.id);

    const after = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    const offer = await prisma.assignment.findFirstOrThrow({
      where: { requestId: request.id },
    });
    const run = await prisma.dispatchRun.findFirstOrThrow({
      where: { requestId: request.id },
    });
    expect(offer).toMatchObject({
      providerId: fresh.id,
      status: 'offered',
      source: 'auto',
      attempt: 1,
      rankingRunId: run.id,
    });
    expect(run.trigger).toBe('intake_approved');
    expect(after.version).toBe(request.version + 1);
    expect(after.autoAttempts).toBe(1);
    const timers = await prisma.requestTimer.findMany({
      where: { requestId: request.id, refId: offer.id },
    });
    expect(timers.map(({ kind }) => kind).sort()).toEqual([
      'T1.expire',
      'T1.reminder',
    ]);
    await expect(
      prisma.auditLog.count({
        where: { entityId: offer.id, action: 'Assignment offered' },
      }),
    ).resolves.toBe(1);
  });

  it('no_eligible: sends the request to the work queue with the reason and an audit row', async () => {
    const request = await seedRequest();

    await cascade(request.id);

    const after = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.needsAssignmentReason).toBe('no_eligible');
    expect(after.lastRunId).not.toBeNull();
    await expect(
      prisma.assignment.count({ where: { requestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditLog.count({
        where: {
          entityId: request.id,
          action: 'Automatic assignment needs staff',
        },
      }),
    ).resolves.toBe(1);
  });

  it('stale run: a manual offer on a ranking run older than 15 minutes is a 409', async () => {
    const request = await seedRequest();
    const provider = await seedProvider();
    const run = await prisma.dispatchRun.create({
      data: {
        requestId: request.id,
        trigger: 'staff_view',
        actorId: staffId,
        at: new Date(Date.now() - 20 * 60_000),
        settings: {},
        eligible: [{ providerId: provider.id, total: 90, factors: {} }],
        excluded: [],
      },
    });

    const error = await refusal(
      service.offer(
        staffId,
        request.id,
        { providerId: provider.id, rankingRunId: run.id },
        undefined,
        '/url',
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe(
      'The ranked list is out of date. Refresh it and choose again.',
    );
  });

  it('override: a provider outside the run’s top suggestion needs a note (422), and the note is audited', async () => {
    const request = await seedRequest();
    const top = await seedProvider();
    const other = await seedProvider({ lastOfferedAt: new Date() });
    const view = await service.rankingRun(staffId, request.id);
    expect(view.eligible[0].providerId).toBe(top.id);
    const dto = { providerId: other.id, rankingRunId: view.runId };

    const error = await refusal(
      service.offer(staffId, request.id, dto, undefined, '/url'),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.message).toBe(
      'Add a note explaining why you chose this provider over the suggestion.',
    );

    await service.offer(
      staffId,
      request.id,
      { ...dto, overrideNote: 'Closer to the site.' },
      undefined,
      '/url',
    );

    const offer = await prisma.assignment.findFirstOrThrow({
      where: { requestId: request.id },
    });
    expect(offer).toMatchObject({
      source: 'manual',
      attempt: null,
      overrideNote: 'Closer to the site.',
    });
    await expect(
      prisma.auditLog.count({
        where: {
          entityId: offer.id,
          action: 'Dispatch suggestion overridden',
        },
      }),
    ).resolves.toBe(1);
  });

  it('expired accept: accepting after expiresAt is refused even if the expiry job has not run', async () => {
    const request = await seedRequest();
    const provider = await seedProvider();
    const offer = await prisma.assignment.create({
      data: {
        requestId: request.id,
        providerId: provider.id,
        providerUserId: provider.userId,
        status: 'offered',
        source: 'auto',
        attempt: 1,
        offeredAt: new Date(Date.now() - 2 * 3_600_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const error = await refusal(
      service.respond(
        provider.userId,
        request.id,
        offer.id,
        { accept: true },
        undefined,
        '/url',
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe('This offer has expired.');
    await expect(
      prisma.assignment.findUniqueOrThrow({ where: { id: offer.id } }),
    ).resolves.toMatchObject({ status: 'offered' });
  });

  it('double accept race: one of two concurrent accepts wins and the other gets a 409', async () => {
    const request = await seedRequest();
    const provider = await seedProvider();
    const offer = await prisma.assignment.create({
      data: {
        requestId: request.id,
        providerId: provider.id,
        providerUserId: provider.userId,
        status: 'offered',
        source: 'auto',
        attempt: 1,
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const accept = () =>
      service.respond(
        provider.userId,
        request.id,
        offer.id,
        { accept: true },
        undefined,
        '/url',
      );

    const results = await Promise.allSettled([accept(), accept()]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect((rejected?.reason as AppError).getStatus()).toBe(409);
    await expect(
      prisma.assignment.findUniqueOrThrow({ where: { id: offer.id } }),
    ).resolves.toMatchObject({ status: 'pending_approval' });
    await expect(
      prisma.requestTimer.count({
        where: { requestId: request.id, kind: 'T3.review', status: 'pending' },
      }),
    ).resolves.toBe(1);
  });

  async function acceptedWithQuote(
    prismaClient: PrismaClient,
    status: 'matched' | 'ready_to_schedule',
    options: { paid: boolean },
  ) {
    const request = await seedRequest(status);
    const provider = await seedProvider();
    const assignment = await prismaClient.assignment.create({
      data: {
        requestId: request.id,
        providerId: provider.id,
        providerUserId: provider.userId,
        status: 'accepted',
        source: 'auto',
        attempt: 1,
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const quote = await prismaClient.quote.create({
      data: {
        requestId: request.id,
        version: 1,
        status: 'accepted',
        items: [],
        total: 500_000n,
        payoutAmount: 300_000n,
        payoutAssignmentId: assignment.id,
        lastEditedBy: randomUUID(),
      },
    });
    if (options.paid)
      await prismaClient.payment.create({
        data: {
          requestId: request.id,
          quoteId: quote.id,
          quoteVersion: 1,
          amount: 500_000n,
          method: 'offline',
          status: 'paid',
          paidAt: new Date(),
          reference: `ref-${randomUUID()}`,
        },
      });
    return { request, provider, assignment, quote };
  }

  it('withdraw with an accepted quote is refused and points at replace', async () => {
    const { request, assignment } = await acceptedWithQuote(prisma, 'matched', {
      paid: false,
    });

    const error = await refusal(
      service.withdraw(
        staffId,
        request.id,
        assignment.id,
        'Customer changed scope.',
        undefined,
        '/url',
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe(
      'This provider has an accepted quote. Replace the provider instead.',
    );
    await expect(
      prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } }),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  it('replace on a paid request keeps the accepted quote and the payment and cancels the old unpaid payout', async () => {
    const { request, provider, assignment, quote } = await acceptedWithQuote(
      prisma,
      'ready_to_schedule',
      { paid: true },
    );
    const payout = await prisma.payout.create({
      data: {
        requestId: request.id,
        assignmentId: assignment.id,
        providerId: provider.id,
        kind: 'primary',
        amount: 300_000n,
        status: 'pending_approval',
      },
    });

    await service.replace(
      staffId,
      request.id,
      assignment.id,
      { note: 'Provider left the project.' },
      undefined,
      '/url',
    );

    const after = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after).toMatchObject({
      status: 'under_review',
      needsAssignmentReason: 'replaced',
    });
    await expect(
      prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } }),
    ).resolves.toMatchObject({ status: 'replaced', endReason: 'replaced' });
    const keptQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
    });
    expect(keptQuote.status).toBe('accepted');
    expect(keptQuote.providerChangedAt).not.toBeNull();
    await expect(
      prisma.payment.count({
        where: { requestId: request.id, status: 'paid' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.payout.findUniqueOrThrow({ where: { id: payout.id } }),
    ).resolves.toMatchObject({
      status: 'cancelled',
      holdReason: 'Provider replaced on this request.',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: assignment.id, action: 'Assignment replaced' },
    });
    expect(audit.metadata).toMatchObject({
      requestId: request.id,
      changes: { oldAssignmentId: assignment.id },
    });
  });
});
