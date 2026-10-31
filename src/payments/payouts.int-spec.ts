import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { encryptSecret } from '../common/utils/crypto.util';
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
import { ClosureService } from '../requests/completion/closure.service';
import { RequestSnapshotLoader } from '../requests/snapshot.loader';
import { UploadsService } from '../uploads/uploads.service';
import { createUser, deleteTestUsers } from '../../test/integration/users';
import {
  TRANSFER_REFERENCE_PATTERN,
  bankVersionOf,
} from './domain/payout-rules';
import { FinanceService } from './finance.service';
import { PAYMENT_GATEWAY } from './payments.service';

/**
 * Payout commands and the closure guard against a real database (05 §6.5,
 * §7; 04 §6.17; plan C.4). Authored under FX-3.6 and not run there; Phase 12
 * runs them against the test database.
 */
describe('payouts (integration)', () => {
  let prisma: PrismaService;
  let finance: FinanceService;
  let closure: ClosureService;
  const actors = new Map<string, ActorContext>();
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const gateway = {
    transfer: jest.fn(),
    verifyTransfer: jest.fn(),
    createRecipient: jest.fn(),
  };
  const createdRequests: string[] = [];
  const createdProviders: string[] = [];

  const staffActor = (userId: string, permissions: string[]): ActorContext =>
    ({
      userId,
      kind: 'staff',
      displayName: 'Finance',
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
        ApprovalsHooks,
        TimersService,
        TimerRegistry,
        FinanceService,
        ClosureService,
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        { provide: UploadsService, useValue: { attach: jest.fn() } },
        { provide: JobsService, useValue: { addTimersKickJob: jest.fn() } },
        { provide: SettingsService, useValue: { snapshot: () => [] } },
        {
          provide: IdempotencyService,
          useValue: {
            lookup: () => Promise.resolve(null),
            store: () => Promise.resolve(),
          },
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
    finance = moduleRef.get(FinanceService);
    closure = moduleRef.get(ClosureService);
  });

  beforeEach(() => {
    dispatch.mockClear();
    gateway.transfer.mockReset();
    gateway.transfer.mockImplementation(() =>
      Promise.resolve({ transferId: `gw-${randomUUID()}`, status: 'pending' }),
    );
    gateway.verifyTransfer.mockReset();
    gateway.verifyTransfer.mockResolvedValue(null);
    gateway.createRecipient.mockReset();
    gateway.createRecipient.mockResolvedValue({ recipientCode: 'RCP_test' });
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
      await prisma.payout.deleteMany({ where: { requestId } });
      await prisma.assignment.deleteMany({ where: { requestId } });
      await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
    }
    for (const providerId of createdProviders.splice(0)) {
      await prisma.providerBankAccount.deleteMany({ where: { providerId } });
      await prisma.providerProfile.deleteMany({ where: { id: providerId } });
    }
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  async function staff(permissions = ['payout.approve', 'view.pricing']) {
    const user = await createUser(prisma);
    actors.set(user.id, staffActor(user.id, permissions));
    return user.id;
  }

  /** An acknowledged request with a verified provider bank and one primary payout in the given state. */
  async function seedPayout(
    options: {
      status?:
        | 'pending_approval'
        | 'approved'
        | 'processing'
        | 'paid'
        | 'on_hold'
        | 'cancelled';
      holdReason?: string | null;
      firstApprover?: string;
    } = {},
  ) {
    const owner = await createUser(prisma);
    const providerUser = await createUser(prisma);
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: owner.id,
        customerName: 'Payout customer',
        title: 'Payout test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for payouts.',
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(Date.now() - 86_400_000),
      },
    });
    createdRequests.push(request.id);
    const provider = await prisma.providerProfile.create({
      data: {
        userId: providerUser.id,
        phone: '+2348000000000',
        trade: 'Architect',
        city: 'Test city',
        services: ['Design'],
        serviceAreas: [],
        skills: { Design: ['Architectural Designs'] },
        workingHours: {},
        bio: 'Integration test provider.',
        verification: 'approved',
      },
    });
    createdProviders.push(provider.id);
    const bank = await prisma.providerBankAccount.create({
      data: {
        providerId: provider.id,
        bankCode: '058',
        bankName: 'Test Bank',
        accountNumberEnc: encryptSecret('0123456789'),
        accountNameEnc: encryptSecret('Test Provider'),
        last4: '6789',
        recipientCodeEnc: encryptSecret('RCP_test'),
        state: 'verified',
        reviewedBy: randomUUID(),
        reviewedAt: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    const assignment = await prisma.assignment.create({
      data: {
        requestId: request.id,
        providerId: provider.id,
        providerUserId: providerUser.id,
        status: 'accepted',
        source: 'manual',
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const status = options.status ?? 'approved';
    const payout = await prisma.payout.create({
      data: {
        requestId: request.id,
        assignmentId: assignment.id,
        providerId: provider.id,
        amount: 9_000_000n,
        status,
        holdReason: options.holdReason ?? null,
        bankAccountId: bank.id,
        bankLast4: bank.last4,
      },
    });
    if (status === 'approved' || status === 'processing')
      await prisma.payoutApproval.create({
        data: {
          payoutId: payout.id,
          step: 1,
          actorId: options.firstApprover ?? randomUUID(),
          bankVersion: bankVersionOf(bank),
        },
      });
    return {
      requestId: request.id,
      payoutId: payout.id,
      providerId: provider.id,
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

  const transferKey = (payoutId: string) => ({
    key: `transfer-${randomUUID()}`,
    url: `/admin/payouts/${payoutId}/transfer`,
  });
  const retryKey = (payoutId: string) => ({
    key: `retry-${randomUUID()}`,
    url: `/admin/payouts/${payoutId}/retry`,
  });

  it('two concurrent transfer calls make one Paystack transfer and one attempt (C-05)', async () => {
    const financeA = await staff();
    const financeB = await staff();
    const seeded = await seedPayout();

    const results = await Promise.all([
      outcome(
        finance.transferPayout(
          financeA,
          seeded.payoutId,
          { method: 'paystack' },
          transferKey(seeded.payoutId),
        ),
      ),
      outcome(
        finance.transferPayout(
          financeB,
          seeded.payoutId,
          { method: 'paystack' },
          transferKey(seeded.payoutId),
        ),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ status: 409 });
    expect(gateway.transfer).toHaveBeenCalledTimes(1);
    const attempts = await prisma.transferAttempt.findMany({
      where: { payoutId: seeded.payoutId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].reference).toMatch(TRANSFER_REFERENCE_PATTERN);
    const payout = await prisma.payout.findUniqueOrThrow({
      where: { id: seeded.payoutId },
    });
    expect(payout.status).toBe('processing');
    expect(payout.transferReference).toBe(attempts[0].reference);
  });

  it('a timeout leaves the payout processing, and the retry verifies the first reference before it sends again (C-05)', async () => {
    const financeId = await staff();
    const seeded = await seedPayout();
    gateway.transfer.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      finance.transferPayout(
        financeId,
        seeded.payoutId,
        { method: 'paystack' },
        transferKey(seeded.payoutId),
      ),
    ).rejects.toThrow('timeout');

    const [first] = await prisma.transferAttempt.findMany({
      where: { payoutId: seeded.payoutId },
    });
    expect(first.status).toBe('pending');
    expect(
      (
        await prisma.payout.findUniqueOrThrow({
          where: { id: seeded.payoutId },
        })
      ).status,
    ).toBe('processing');

    // The first call is older than the retry cool-down, and Paystack does not know its reference.
    await prisma.transferAttempt.update({
      where: { id: first.id },
      data: { submittedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const order: string[] = [];
    gateway.verifyTransfer.mockImplementation((reference: string) => {
      order.push(`verify:${reference}`);
      return Promise.resolve(null);
    });
    gateway.transfer.mockImplementation(() => {
      order.push('transfer');
      return Promise.resolve({ transferId: 'gw-2', status: 'pending' });
    });

    await finance.retryTransfer(
      financeId,
      seeded.payoutId,
      retryKey(seeded.payoutId),
    );

    expect(order).toEqual([`verify:${first.reference}`, 'transfer']);
    const attempts = await prisma.transferAttempt.findMany({
      where: { payoutId: seeded.payoutId },
      orderBy: { createdAt: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: 'failed' });
    expect(attempts[1].reference).not.toBe(first.reference);
    expect(attempts[1].reference).toMatch(TRANSFER_REFERENCE_PATTERN);
  });

  it('a retry settles instead of sending again when the first transfer actually went through', async () => {
    const financeId = await staff();
    const seeded = await seedPayout();
    gateway.transfer.mockRejectedValueOnce(new Error('timeout'));
    await outcome(
      finance.transferPayout(
        financeId,
        seeded.payoutId,
        { method: 'paystack' },
        transferKey(seeded.payoutId),
      ),
    );
    const [first] = await prisma.transferAttempt.findMany({
      where: { payoutId: seeded.payoutId },
    });
    await prisma.transferAttempt.update({
      where: { id: first.id },
      data: { submittedAt: new Date(Date.now() - 10 * 60_000) },
    });
    gateway.transfer.mockClear();
    gateway.verifyTransfer.mockResolvedValue({
      reference: first.reference,
      status: 'success',
      amount: 9_000_000,
    });

    await finance.retryTransfer(
      financeId,
      seeded.payoutId,
      retryKey(seeded.payoutId),
    );

    expect(gateway.transfer).not.toHaveBeenCalled();
    expect(
      await prisma.transferAttempt.count({
        where: { payoutId: seeded.payoutId },
      }),
    ).toBe(1);
    const payout = await prisma.payout.findUniqueOrThrow({
      where: { id: seeded.payoutId },
    });
    expect(payout.status).toBe('paid');
    expect(payout.paidAt).not.toBeNull();
  });

  it('a late failed event for an earlier attempt does not overwrite the newer attempt (C-19)', async () => {
    const financeId = await staff();
    const seeded = await seedPayout();
    await finance.transferPayout(
      financeId,
      seeded.payoutId,
      { method: 'paystack' },
      transferKey(seeded.payoutId),
    );
    const [first] = await prisma.transferAttempt.findMany({
      where: { payoutId: seeded.payoutId },
    });
    await prisma.transferAttempt.update({
      where: { id: first.id },
      data: { submittedAt: new Date(Date.now() - 10 * 60_000) },
    });
    gateway.verifyTransfer.mockResolvedValueOnce({
      reference: first.reference,
      status: 'failed',
    });
    await finance.retryTransfer(
      financeId,
      seeded.payoutId,
      retryKey(seeded.payoutId),
    );
    const second = await prisma.transferAttempt.findFirstOrThrow({
      where: { payoutId: seeded.payoutId, id: { not: first.id } },
    });

    await finance.settleTransferFromGateway(first.reference, 'failed', {
      actor: null,
    });

    const payout = await prisma.payout.findUniqueOrThrow({
      where: { id: seeded.payoutId },
    });
    expect(payout.status).toBe('processing');
    expect(payout.transferReference).toBe(second.reference);
  });

  describe('closure guard (04 §6.17, C-18)', () => {
    const closeRequest = async (requestId: string) => {
      const closer = await createUser(prisma);
      actors.set(closer.id, staffActor(closer.id, ['request.close']));
      return closure.close(
        { id: closer.id } as never,
        requestId,
        { note: 'Closing after the defects window.' },
        undefined,
        '/url',
      );
    };

    it('closes when the primary payout is paid', async () => {
      const seeded = await seedPayout({ status: 'paid' });

      await closeRequest(seeded.requestId);

      expect(
        (
          await prisma.serviceRequest.findUniqueOrThrow({
            where: { id: seeded.requestId },
          })
        ).status,
      ).toBe('closed');
    });

    it('closes when the primary payout is on_hold with a reason', async () => {
      const seeded = await seedPayout({
        status: 'on_hold',
        holdReason: 'Open customer issue',
      });

      await closeRequest(seeded.requestId);

      expect(
        (
          await prisma.serviceRequest.findUniqueOrThrow({
            where: { id: seeded.requestId },
          })
        ).status,
      ).toBe('closed');
    });

    it.each([
      ['on_hold without a reason', { status: 'on_hold' as const }],
      ['pending approval', { status: 'pending_approval' as const }],
      ['processing', { status: 'processing' as const }],
      ['cancelled', { status: 'cancelled' as const }],
    ])(
      'refuses to close while the primary payout is %s',
      async (_name, seed) => {
        const seeded = await seedPayout(seed);

        await expect(closeRequest(seeded.requestId)).rejects.toMatchObject({
          status: 409,
          message:
            'A provider payout must be paid or held with a reason before closure.',
        });
        expect(
          (
            await prisma.serviceRequest.findUniqueOrThrow({
              where: { id: seeded.requestId },
            })
          ).status,
        ).toBe('acknowledged');
      },
    );

    it('a rejected second approval keeps the request open because the payout returns to pending approval', async () => {
      const first = await staff();
      const second = await staff();
      const seeded = await seedPayout({
        status: 'approved',
        firstApprover: first,
      });
      await prisma.payout.update({
        where: { id: seeded.payoutId },
        data: { status: 'awaiting_second_approval' },
      });

      await finance.secondApprovePayout(
        second,
        seeded.payoutId,
        false,
        'Bank name does not match.',
      );

      expect(
        (
          await prisma.payout.findUniqueOrThrow({
            where: { id: seeded.payoutId },
          })
        ).status,
      ).toBe('pending_approval');
      await expect(closeRequest(seeded.requestId)).rejects.toMatchObject({
        status: 409,
      });
    });
  });
});
