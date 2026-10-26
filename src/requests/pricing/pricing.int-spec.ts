import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
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
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { ApprovalsHooks } from '../approvals.hooks';
import { RequestCommandRunner } from '../command-runner';
import { RequestSnapshotLoader } from '../snapshot.loader';
import { PricingService } from './pricing.service';

/**
 * Integration cases for quote sign-off and the customer decision (audit
 * B-15 to B-21). Authored under FX-3.3 and not run there; Phase 12 runs them
 * against the test database.
 */
describe('pricing and quotes (integration)', () => {
  let prisma: PrismaService;
  let service: PricingService;
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const actors = new Map<string, ActorContext>();
  const createdRequests: string[] = [];
  const cityId = randomUUID();
  const districtId = randomUUID();
  const items = [{ description: 'Labour', quantity: 2, unitPrice: 250_000 }];

  const staffActor = (userId: string, permissions: string[]): ActorContext =>
    ({
      userId,
      kind: 'staff',
      displayName: 'Staff',
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
  const customerActor = (userId: string): ActorContext =>
    ({
      userId,
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    }) as unknown as ActorContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RequestSnapshotLoader,
        RequestCommandRunner,
        ApprovalsHooks,
        TimersService,
        PricingService,
        { provide: TimerRegistry, useValue: new TimerRegistry() },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        {
          provide: SettingsService,
          useValue: {
            snapshot: () => [
              { key: 'quote.approvalThreshold', value: 100_000 },
              { key: 'payment.dueDays', value: 7 },
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
    service = moduleRef.get(PricingService);
  });

  afterEach(async () => {
    dispatch.mockClear();
    for (const requestId of createdRequests.splice(0)) {
      await prisma.requestTimer.deleteMany({ where: { requestId } });
      await prisma.auditLog.deleteMany({
        where: { metadata: { path: ['requestId'], equals: requestId } },
      });
      await prisma.cancellation.deleteMany({ where: { requestId } });
      await prisma.quote.deleteMany({ where: { requestId } });
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

  async function seedRequest(status: 'matched' | 'quoted') {
    const owner = await createUser(prisma);
    actors.set(owner.id, customerActor(owner.id));
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: owner.id,
        customerName: 'Pricing customer',
        title: 'Pricing test',
        service: 'Design',
        cityId,
        districtId,
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for pricing.',
        details: { designType: 'Architectural plan' },
        status,
        intakeState: 'approved',
      },
    });
    createdRequests.push(request.id);
    const providerUser = await createUser(prisma);
    const everyDay = { start: '00:00', end: '23:59' };
    const profile = await prisma.providerProfile.create({
      data: {
        userId: providerUser.id,
        phone: '+2348000000000',
        trade: 'Architect',
        city: 'Test city',
        services: ['Design'],
        serviceAreas: [],
        serviceAreaIds: [districtId],
        skills: { Design: ['Architectural plan'] },
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
    const assignment = await prisma.assignment.create({
      data: {
        requestId: request.id,
        providerId: profile.id,
        providerUserId: providerUser.id,
        status: 'accepted',
        source: 'manual',
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { request, owner, assignment };
  }

  async function seedStaff(permissions: string[]) {
    const user = await createUser(prisma);
    actors.set(user.id, staffActor(user.id, permissions));
    return user.id;
  }

  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as AppError;
    }
    throw new Error('Expected the command to be refused.');
  };

  it('publish above the threshold holds the draft, and a different approver sends it with the held note', async () => {
    const { request } = await seedRequest('matched');
    const pricing = await seedStaff(['quote.manage']);
    const approver = await seedStaff(['quote.approve']);

    const saved = await service.saveQuote(
      pricing,
      request.id,
      { items },
      undefined,
      '/url',
    );
    const quoteId = (saved.body.quote as { id: string }).id;
    const held = await service.publish(
      pricing,
      request.id,
      quoteId,
      { revision: 1, pricingOverrideNote: 'Urgent, no costing yet' },
      undefined,
      '/url',
    );

    expect(held.status).toBe(202);
    const afterHold = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
    });
    expect(afterHold).toMatchObject({
      status: 'draft',
      approvalRequestedBy: pricing,
      pricingOverrideNote: 'Urgent, no costing yet',
    });
    expect(afterHold.approvalRequestedAt).not.toBeNull();
    await expect(
      prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ status: 'matched' });

    await service.approve(
      approver,
      request.id,
      quoteId,
      { revision: 1 },
      undefined,
      '/url',
    );

    const sent = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
    });
    expect(sent).toMatchObject({
      status: 'sent',
      approvedBy: approver,
      selfApproved: false,
      publishedBy: approver,
      pricingOverrideNote: 'Urgent, no costing yet',
    });
    expect(sent.validUntil).not.toBeNull();
    await expect(
      prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ status: 'quoted' });
    const timers = await prisma.requestTimer.findMany({
      where: { requestId: request.id, refId: quoteId },
    });
    expect(timers.map(({ kind }) => kind).sort()).toEqual([
      'T8.expire',
      'T8.reminder1d',
      'T8.reminder3d',
    ]);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: quoteId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map(({ action }) => action)).toEqual([
      'Quote draft saved',
      'Quote approval requested',
      'Quote approved',
    ]);
  });

  it('the last editor cannot approve their own held draft', async () => {
    const { request } = await seedRequest('matched');
    const both = await seedStaff(['quote.manage', 'quote.approve']);
    const saved = await service.saveQuote(
      both,
      request.id,
      { items },
      undefined,
      '/url',
    );
    const quoteId = (saved.body.quote as { id: string }).id;
    const held = await service.publish(
      both,
      request.id,
      quoteId,
      { revision: 1, pricingOverrideNote: 'No costing yet' },
      undefined,
      '/url',
    );
    expect(held.status).toBe(202);

    const error = await refusal(
      service.approve(
        both,
        request.id,
        quoteId,
        { revision: 1 },
        undefined,
        '/url',
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe(
      'You edited this quote last. Another approver must sign it off.',
    );
    await expect(
      prisma.quote.findUniqueOrThrow({ where: { id: quoteId } }),
    ).resolves.toMatchObject({ status: 'draft' });
  });

  it('declining a quote creates exactly one pending cancellation and starts T19', async () => {
    const { request, owner } = await seedRequest('quoted');
    const quote = await prisma.quote.create({
      data: {
        requestId: request.id,
        version: 1,
        status: 'sent',
        items,
        total: 500_000n,
        lastEditedBy: owner.id,
        publishedAt: new Date(),
        validUntil: new Date(Date.now() + 14 * 86_400_000),
      },
    });

    await service.respond(
      { id: owner.id } as never,
      request.id,
      quote.id,
      { decision: 'declined', note: 'Too expensive for us.' },
      undefined,
      '/url',
    );

    const cancellations = await prisma.cancellation.findMany({
      where: { requestId: request.id },
    });
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      status: 'pending',
      requestedBy: 'customer',
      reasonCode: 'quote_declined',
      note: 'Too expensive for us.',
    });
    await expect(
      prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ status: 'matched' });
    await expect(
      prisma.quote.findUniqueOrThrow({ where: { id: quote.id } }),
    ).resolves.toMatchObject({ status: 'declined' });
    const timers = await prisma.requestTimer.findMany({
      where: {
        requestId: request.id,
        kind: 'T19.followup',
        refId: cancellations[0].id,
      },
    });
    expect(timers).toHaveLength(1);

    const again = await refusal(
      service.respond(
        { id: owner.id } as never,
        request.id,
        quote.id,
        { decision: 'declined', note: 'Still too expensive.' },
        undefined,
        '/url',
      ),
    );
    expect(again.getStatus()).toBe(409);
    await expect(
      prisma.cancellation.count({ where: { requestId: request.id } }),
    ).resolves.toBe(1);
  });

  it('a decline is refused while a cancellation is already pending', async () => {
    const { request, owner } = await seedRequest('quoted');
    const quote = await prisma.quote.create({
      data: {
        requestId: request.id,
        version: 1,
        status: 'sent',
        items,
        total: 500_000n,
        lastEditedBy: owner.id,
        publishedAt: new Date(),
        validUntil: new Date(Date.now() + 14 * 86_400_000),
      },
    });
    await prisma.cancellation.create({
      data: {
        requestId: request.id,
        requestedBy: 'customer',
        requestedById: owner.id,
        reasonCode: 'customer_changed_mind',
        note: 'Plans changed.',
        stage: 'quoted',
      },
    });

    const error = await refusal(
      service.respond(
        { id: owner.id } as never,
        request.id,
        quote.id,
        { decision: 'declined', note: 'Too expensive for us.' },
        undefined,
        '/url',
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe(
      'Your cancellation request is already awaiting XPro.',
    );
    await expect(
      prisma.cancellation.count({ where: { requestId: request.id } }),
    ).resolves.toBe(1);
  });

  it('accepting a quote moves to awaiting_payment with the configured due date', async () => {
    const { request, owner } = await seedRequest('quoted');
    const quote = await prisma.quote.create({
      data: {
        requestId: request.id,
        version: 1,
        status: 'sent',
        items,
        total: 500_000n,
        lastEditedBy: owner.id,
        publishedAt: new Date(),
        validUntil: new Date(Date.now() + 14 * 86_400_000),
      },
    });

    await service.respond(
      { id: owner.id } as never,
      request.id,
      quote.id,
      { decision: 'accepted' },
      undefined,
      '/url',
    );

    const accepted = await prisma.quote.findUniqueOrThrow({
      where: { id: quote.id },
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.respondedAt).not.toBeNull();
    expect(
      Math.round(
        (accepted.paymentDueAt!.getTime() - accepted.acceptedAt!.getTime()) /
          86_400_000,
      ),
    ).toBe(7);
    await expect(
      prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ status: 'awaiting_payment' });
    const events = dispatch.mock.calls.map(
      ([, event]: [unknown, string]) => event,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'quote.payment_due',
        'quote.accepted',
        'quote.accepted_provider',
      ]),
    );
  });
});
