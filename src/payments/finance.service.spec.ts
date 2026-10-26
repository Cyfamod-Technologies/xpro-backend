import type { ActorContext } from '../platform/actor/actor.types';
import { systemCommandKit } from '../requests/system-command.testkit';
import { TRANSFER_REFERENCE_PATTERN } from './domain/payout-rules';
import { FinanceService } from './finance.service';
import { GatewayRejectedError } from './payment-gateway';

jest.mock('../common/utils/crypto.util', () => ({
  decryptSecret: (value: string) => `plain:${value}`,
  encryptSecret: (value: string) => `enc:${value}`,
}));

const NOW = new Date('2026-10-26T10:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 60 * 60_000);
const DAY = 24 * 60 * 60 * 1000;

const staff = (
  userId: string,
  permissions: string[] = ['payout.approve', 'view.pricing'],
): ActorContext =>
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

const bankRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'bank-1',
  providerId: 'provider-1',
  state: 'verified',
  last4: '1234',
  bankCode: '058',
  accountNumberEnc: 'acct',
  accountNameEnc: 'name',
  recipientCodeEnc: 'rcp',
  reviewedBy: 'bank-reviewer',
  reviewedAt: new Date(NOW.getTime() - 30 * DAY),
  createdAt: new Date(NOW.getTime() - 31 * DAY),
  ...overrides,
});
const BANK_VERSION = `bank-1:${bankRow().reviewedAt.toISOString()}`;

const approvalRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'approval-1',
  payoutId: 'payout-1',
  step: 1,
  actorId: 'finance-1',
  bankVersion: BANK_VERSION,
  createdAt: LONG_AGO,
  ...overrides,
});

const payoutRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'payout-1',
  requestId: 'request-1',
  assignmentId: 'assignment-1',
  providerId: 'provider-1',
  kind: 'primary',
  amount: 9_000_000n,
  status: 'pending_approval',
  holdReason: null,
  holdSource: null,
  approvalDueAt: null,
  bankAccountId: 'bank-1',
  bankLast4: '1234',
  transferReference: null,
  transferProofId: null,
  transferRecordedBy: null,
  reconciledBy: null,
  paidAt: null,
  version: 1,
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
  approvals: [] as unknown[],
  ...overrides,
});

const attemptRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'attempt-1',
  payoutId: 'payout-1',
  reference: 'xpro_tr_' + 'a'.repeat(32),
  amount: 9_000_000n,
  status: 'pending',
  submittedAt: LONG_AGO,
  createdAt: LONG_AGO,
  ...overrides,
});

type Options = {
  payout?: Record<string, unknown>;
  claim?: number;
  banks?: { verified?: Record<string, unknown> | null; pending?: number };
  snap?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  transfer?: () => Promise<{ transferId?: string; status: string }>;
  verifyTransfer?: () => Promise<unknown>;
  latestAttempt?: Record<string, unknown> | null;
  provider?: Record<string, unknown>;
  issues?: string[];
};

function build(options: Options = {}) {
  const calls: string[] = [];
  const payout = payoutRow(options.payout);
  const verifiedBank =
    options.banks?.verified === undefined ? bankRow() : options.banks.verified;
  const provider = {
    verification: 'verified',
    reliabilityStatus: 'normal',
    userId: 'provider-user-1',
    user: { status: 'active' },
    ...options.provider,
  };
  const tx = {
    $queryRaw: jest.fn(() => {
      calls.push('lock');
      return Promise.resolve([]);
    }),
    payout: {
      findUnique: jest.fn().mockResolvedValue(payout),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push('payout.create');
        return Promise.resolve({ id: 'payout-new', ...args.data });
      }),
      updateMany: jest.fn((_args: unknown) => {
        calls.push('payout.claim');
        return Promise.resolve({ count: options.claim ?? 1 });
      }),
    },
    payoutApproval: {
      create: jest.fn(() => {
        calls.push('approval.create');
        return Promise.resolve({});
      }),
    },
    transferAttempt: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push('attempt.create');
        return Promise.resolve({ id: 'attempt-new', ...args.data });
      }),
      updateMany: jest.fn((_args: unknown) => {
        calls.push('attempt.update');
        return Promise.resolve({ count: 1 });
      }),
      findFirst: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
    },
    providerBankAccount: {
      findFirst: jest.fn().mockResolvedValue(verifiedBank),
      findUnique: jest.fn().mockResolvedValue(verifiedBank),
      count: jest.fn().mockResolvedValue(options.banks?.pending ?? 0),
    },
    providerProfile: { findUnique: jest.fn().mockResolvedValue(provider) },
    issue: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (options.issues ?? []).map((status) => ({ status })),
        ),
    },
  };
  const kit = systemCommandKit({
    tx,
    now: NOW,
    settings: options.settings ?? {},
    snap: {
      status: 'acknowledged',
      payment: { paid: true, pendingPaymentAt: null, offlineRecorded: false },
      openIssues: [],
      hold: null,
      ...options.snap,
    } as never,
  });
  const latest =
    options.latestAttempt === undefined ? attemptRow() : options.latestAttempt;
  const prisma = {
    payout: {
      findUnique: jest.fn().mockResolvedValue(payout),
      findUniqueOrThrow: jest.fn().mockResolvedValue(payout),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    transferAttempt: {
      findFirst: jest.fn().mockResolvedValue(latest),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          latest ? { ...latest, payout: { requestId: 'request-1' } } : null,
        ),
    },
    providerBankAccount: {
      findUnique: jest.fn().mockResolvedValue(verifiedBank),
      update: jest.fn().mockResolvedValue({}),
    },
    providerProfile: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((queries: Array<Promise<unknown>>) =>
      Promise.all(queries),
    ),
  };
  const gateway = {
    transfer: jest.fn(
      options.transfer ??
        (() => {
          calls.push('gateway.transfer');
          return Promise.resolve({ transferId: 'gw-1', status: 'pending' });
        }),
    ),
    verifyTransfer: jest.fn(
      options.verifyTransfer ??
        (() => {
          calls.push('gateway.verify');
          return Promise.resolve(null);
        }),
    ),
    createRecipient: jest.fn().mockResolvedValue({ recipientCode: 'RCP_new' }),
  };
  const actors = { resolve: jest.fn() };
  const uploads = { attach: jest.fn().mockResolvedValue([]) };
  const idempotency = {
    lookup: jest.fn().mockResolvedValue(null),
    store: jest.fn().mockResolvedValue(undefined),
  };
  const service = new FinanceService(
    prisma as never,
    actors as never,
    uploads as never,
    gateway as never,
    kit.runner,
    idempotency as never,
  );
  return {
    service,
    tx,
    prisma,
    gateway,
    actors,
    uploads,
    idempotency,
    calls,
    payout,
    ...kit,
  };
}

const asStaff = (
  h: ReturnType<typeof build>,
  userId: string,
  permissions?: string[],
) => h.actors.resolve.mockResolvedValue(staff(userId, permissions));

const idem = { key: 'idem-key-12345', url: '/admin/payouts/payout-1/transfer' };

describe('FinanceService.createPrimary (FD-7, C-20)', () => {
  const input = {
    requestId: 'request-1',
    assignmentId: 'assignment-1',
    providerId: 'provider-1',
    amount: 9_000_000n,
    payoutAssignmentId: 'assignment-1',
  };
  const settings = {
    'calendar.holidays': [],
    'approvals.deadlines': { payout: 1200 },
  };

  it('creates one pending payout due 20 working hours later and opens the payout item', async () => {
    const h = build({ settings });

    const created = await h.service.createPrimary(h.ctx, input);

    expect(h.tx.payout.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'request-1',
        assignmentId: 'assignment-1',
        providerId: 'provider-1',
        kind: 'primary',
        amount: 9_000_000n,
        status: 'pending_approval',
        holdReason: null,
        holdSource: null,
        bankAccountId: 'bank-1',
        createdAt: NOW,
        approvalDueAt: new Date('2026-10-28T10:00:00.000Z'),
      }) as unknown,
    });
    expect(created.id).toBe('payout-new');
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'payout', itemId: 'payout-new' },
    ]);
    expect(h.effects.audit[0]).toMatchObject({
      action: 'Payout created',
      data: { resourceType: 'payout' },
    });
  });

  it.each(['open', 'rework', 'disputed'])(
    'creates the payout on_hold with source issue when an issue is %s',
    async (status) => {
      const h = build({ settings, issues: [status] });

      await h.service.createPrimary(h.ctx, input);

      expect(h.tx.payout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'on_hold',
          holdSource: 'issue',
          holdReason: expect.any(String) as string,
        }) as unknown,
      });
      expect(h.effects.approvalOpens).toHaveLength(1);
    },
  );

  it('creates the payout on_hold with source suspension when the provider is blocked', async () => {
    const h = build({ settings, provider: { user: { status: 'suspended' } } });

    await h.service.createPrimary(h.ctx, input);

    expect(h.tx.payout.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'on_hold',
        holdSource: 'suspension',
      }) as unknown,
    });
  });

  it('returns the existing primary payout of the same assignment without writing', async () => {
    const h = build({ settings });
    h.tx.payout.findFirst.mockResolvedValue(payoutRow());

    const existing = await h.service.createPrimary(h.ctx, input);

    expect(existing.id).toBe('payout-1');
    expect(h.tx.payout.findFirst).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        kind: 'primary',
        status: { not: 'cancelled' },
      },
    });
    expect(h.tx.payout.create).not.toHaveBeenCalled();
    expect(h.effects.approvalOpens).toEqual([]);
  });

  it('refuses an existing primary payout that belongs to another assignment', async () => {
    const h = build({ settings });
    h.tx.payout.findFirst.mockResolvedValue(
      payoutRow({ assignmentId: 'old-assignment', status: 'paid' }),
    );

    await expect(h.service.createPrimary(h.ctx, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(h.tx.payout.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the payout was set for a replaced assignment',
      { payoutAssignmentId: 'old' },
    ],
    ['there is no payout amount', { amount: null }],
    ['the payout amount is zero', { amount: 0n }],
  ])('refuses to pay when %s (DUP-07)', async (_name, change) => {
    const h = build({ settings });

    await expect(
      h.service.createPrimary(h.ctx, { ...input, ...change }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Set the provider payout before confirming completion.',
    });
    expect(h.tx.payout.create).not.toHaveBeenCalled();
  });
});

describe('FinanceService.approvePayout (C-17)', () => {
  it('refuses an open issue with the exact 05 message and writes nothing', async () => {
    const h = build({
      snap: { openIssues: [{ status: 'rework' }] },
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Resolve the open issue before approving this payout.',
    });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.tx.payoutApproval.create).not.toHaveBeenCalled();
  });

  it('refuses unverified bank details with the exact 05 message', async () => {
    const h = build({ banks: { verified: null } });
    asStaff(h, 'finance-1');

    await expect(
      h.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({
      message:
        "Verify the provider's bank details before approving this payout.",
    });
  });

  it('blocks approval while a newer bank change is pending', async () => {
    const h = build({ banks: { pending: 1 } });
    asStaff(h, 'finance-1');

    await expect(
      h.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses the reviewer of a bank change in the last 7 days with 403', async () => {
    const h = build({
      banks: {
        verified: bankRow({
          reviewedBy: 'finance-1',
          reviewedAt: new Date(NOW.getTime() - 2 * DAY),
        }),
      },
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({
      status: 403,
      message:
        'Another staff member must approve this payout after the bank change.',
    });
  });

  it('refuses a request that is not acknowledged or an unsettled collection', async () => {
    const notAcknowledged = build({ snap: { status: 'completion_pending' } });
    asStaff(notAcknowledged, 'finance-1');
    await expect(
      notAcknowledged.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({ status: 409 });

    const unsettled = build({
      snap: { payment: { paid: false, pendingPaymentAt: null } },
    });
    asStaff(unsettled, 'finance-1');
    await expect(
      unsettled.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('claims from pending_approval, snapshots the bank, records the approval and closes the item', async () => {
    const h = build();
    asStaff(h, 'finance-1');

    await h.service.approvePayout('finance-1', 'payout-1', ' Looks right. ');

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'pending_approval' },
      data: {
        status: 'approved',
        bankAccountId: 'bank-1',
        bankLast4: '1234',
        version: { increment: 1 },
      },
    });
    expect(h.tx.payoutApproval.create).toHaveBeenCalledWith({
      data: {
        payoutId: 'payout-1',
        step: 1,
        actorId: 'finance-1',
        note: 'Looks right.',
        bankVersion: BANK_VERSION,
      },
    });
    expect(h.effects.approvalCloses).toEqual([
      { kind: 'payout', itemId: 'payout-1', reason: 'approved' },
    ]);
    expect(h.effects.audit[0].action).toBe('Payout approved');
    expect(h.calls.indexOf('lock')).toBeLessThan(
      h.calls.indexOf('payout.claim'),
    );
  });

  it('is a no-op when the conditional claim matches nothing (count 0)', async () => {
    const h = build({ claim: 0 });
    asStaff(h, 'finance-1');

    await expect(
      h.service.approvePayout('finance-1', 'payout-1'),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This payout is not awaiting approval.',
    });
    expect(h.tx.payoutApproval.create).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
    expect(h.effects.approvalCloses).toEqual([]);
  });

  it('requires a second approval only for an amount above the threshold', async () => {
    const above = build({
      settings: { 'payout.secondApprovalThreshold': 8_999_999 },
    });
    asStaff(above, 'finance-1');
    await above.service.approvePayout('finance-1', 'payout-1');
    expect(above.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'pending_approval' },
      data: expect.objectContaining({
        status: 'awaiting_second_approval',
      }) as unknown,
    });
    expect(above.effects.approvalOpens).toEqual([
      { kind: 'payout_second', itemId: 'payout-1' },
    ]);

    const equal = build({
      settings: { 'payout.secondApprovalThreshold': 9_000_000 },
    });
    asStaff(equal, 'finance-1');
    await equal.service.approvePayout('finance-1', 'payout-1');
    expect(equal.tx.payout.updateMany).toHaveBeenCalledWith({
      where: expect.anything() as unknown,
      data: expect.objectContaining({ status: 'approved' }) as unknown,
    });
  });

  it('needs the payout.approve permission', async () => {
    const h = build();
    asStaff(h, 'staff-1', ['view.pricing']);

    await expect(
      h.service.approvePayout('staff-1', 'payout-1'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('FinanceService.secondApprovePayout (C-18)', () => {
  const awaiting = {
    status: 'awaiting_second_approval',
    approvals: [approvalRow()],
  };

  it('lets any payout.approve holder other than the first approver approve', async () => {
    const h = build({ payout: awaiting });
    asStaff(h, 'finance-2');

    await h.service.secondApprovePayout('finance-2', 'payout-1', true, 'OK.');

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'awaiting_second_approval' },
      data: { status: 'approved', version: { increment: 1 } },
    });
    expect(h.tx.payoutApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        step: 2,
        actorId: 'finance-2',
      }) as unknown,
    });
    expect(h.effects.approvalCloses[0]).toMatchObject({
      kind: 'payout_second',
    });
  });

  it('refuses the first approver', async () => {
    const h = build({ payout: awaiting });
    asStaff(h, 'finance-1');

    await expect(
      h.service.secondApprovePayout('finance-1', 'payout-1', true, 'OK.'),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
  });

  it('returns a rejected payout to pending_approval, never cancelled, and reopens the payout item', async () => {
    const h = build({ payout: awaiting });
    asStaff(h, 'finance-2');

    await h.service.secondApprovePayout(
      'finance-2',
      'payout-1',
      false,
      'Name does not match.',
    );

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'awaiting_second_approval' },
      data: { status: 'pending_approval', version: { increment: 1 } },
    });
    expect(h.tx.payoutApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        step: 2,
        note: 'Name does not match.',
      }) as unknown,
    });
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'payout', itemId: 'payout-1' },
    ]);
    expect(h.effects.audit[0].action).toBe('Payout second approval rejected');
  });

  it('refuses when the first approval covered other bank details', async () => {
    const h = build({
      payout: {
        ...awaiting,
        approvals: [
          approvalRow({ bankVersion: 'bank-0:2026-01-01T00:00:00.000Z' }),
        ],
      },
    });
    asStaff(h, 'finance-2');

    await expect(
      h.service.secondApprovePayout('finance-2', 'payout-1', true, 'OK.'),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('bank details changed') as string,
    });
  });

  it('is a no-op when the payout is no longer awaiting a second approval', async () => {
    const h = build({ payout: { status: 'approved' } });
    asStaff(h, 'finance-2');

    await expect(
      h.service.secondApprovePayout('finance-2', 'payout-1', true, 'OK.'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.payoutApproval.create).not.toHaveBeenCalled();
  });
});

describe('FinanceService hold and release (C-40)', () => {
  it.each([
    'pending_approval',
    'awaiting_second_approval',
    'approved',
    'failed',
  ])('holds a %s payout with source manual', async (status) => {
    const h = build({ payout: { status } });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', true, 'Checking bank.');

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status },
      data: {
        status: 'on_hold',
        holdReason: 'Checking bank.',
        holdSource: 'manual',
        version: { increment: 1 },
      },
    });
    const audit = h.effects.audit[0].data as { changes: { after: unknown } };
    expect(audit.changes.after).toMatchObject({ status: 'on_hold' });
  });

  it('does not store the actor in the hold source', async () => {
    const h = build({ payout: { status: 'approved' } });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', true, 'Checking bank.');

    const data = h.tx.payout.updateMany.mock.calls[0][0] as {
      data: { holdSource: string };
    };
    expect(data.data.holdSource).not.toContain('finance-1');
  });

  it('flags a processing transfer for urgent review instead of holding it', async () => {
    const h = build({ payout: { status: 'processing' } });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', true, 'Wrong account.');

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'processing' },
      data: {
        holdReason: 'Wrong account.',
        holdSource: 'manual',
        version: { increment: 1 },
      },
    });
    expect(h.effects.notify[0]).toMatchObject({
      event: 'payout.needs_attention',
    });
    expect(h.effects.audit[0].action).toBe('Payout flagged for urgent review');
  });

  it.each(['paid', 'cancelled', 'reversed', 'on_hold'])(
    'cannot hold a %s payout',
    async (status) => {
      const h = build({ payout: { status } });
      asStaff(h, 'finance-1');

      await expect(
        h.service.payoutHold('finance-1', 'payout-1', true, 'Why not.'),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('releases to pending_approval and clears the hold', async () => {
    const h = build({
      payout: { status: 'on_hold', holdSource: 'manual', holdReason: 'x' },
    });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', false, 'Resolved.');

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'on_hold' },
      data: expect.objectContaining({
        status: 'pending_approval',
        holdReason: null,
        holdSource: null,
      }) as unknown,
    });
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'payout', itemId: 'payout-1' },
    ]);
  });

  it('refuses a release while an issue is still open', async () => {
    const h = build({
      payout: { status: 'on_hold', holdSource: 'issue' },
      snap: { openIssues: [{ status: 'disputed' }] },
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.payoutHold('finance-1', 'payout-1', false, 'Resolved.'),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
  });

  it('lists the approvals for other bank details as invalidated on release', async () => {
    const h = build({
      payout: {
        status: 'on_hold',
        holdSource: 'bank_change',
        approvals: [
          approvalRow({ id: 'stale', bankVersion: 'bank-0:old' }),
          approvalRow({ id: 'fresh' }),
        ],
      },
    });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', false, 'Verified.');

    expect(
      (h.effects.audit[0].data as { changes: Record<string, unknown> }).changes,
    ).toMatchObject({ invalidatedApprovalIds: ['stale'] });
  });

  it('needs a reason', async () => {
    const h = build();
    asStaff(h, 'finance-1');

    await expect(
      h.service.payoutHold('finance-1', 'payout-1', true, '  '),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('FinanceService.holdForIssue (D-28, 05 §6.6)', () => {
  const hold = (h: ReturnType<typeof build>) =>
    h.service.holdForIssue(h.ctx, 'request-1', 'issue-1');

  it('asks only for unpaid and in-flight payouts of the request', async () => {
    const h = build();

    await expect(hold(h)).resolves.toEqual({ held: [], flagged: [] });

    expect(h.tx.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          requestId: 'request-1',
          status: {
            in: [
              'pending_approval',
              'awaiting_second_approval',
              'approved',
              'failed',
              'processing',
            ],
          },
        },
      }),
    );
    expect(h.effects.audit).toEqual([]);
  });

  it('puts an unpaid payout on hold with source issue, a version bump and an audit row', async () => {
    const h = build();
    h.tx.payout.findMany.mockResolvedValue([
      payoutRow({ id: 'payout-1', status: 'approved' }),
    ]);

    await expect(hold(h)).resolves.toEqual({
      held: ['payout-1'],
      flagged: [],
    });

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'approved' },
      data: {
        status: 'on_hold',
        holdReason: 'An issue is open on this request.',
        holdSource: 'issue',
        version: { increment: 1 },
      },
    });
    expect(h.effects.audit[0]).toMatchObject({
      action: 'Payout held',
      data: {
        resourceType: 'payout',
        resourceId: 'payout-1',
        note: 'An issue is open on this request.',
        changes: {
          before: { status: 'approved' },
          after: { status: 'on_hold' },
          holdSource: 'issue',
          issueId: 'issue-1',
          sourceEvent: 'issue.raise',
        },
      },
    });
    expect(h.effects.notify.map(({ event }) => event)).toEqual([
      'payout.held',
      'payout.finance_update',
    ]);
    expect(h.effects.notify[0].params).toMatchObject({
      reason: 'On hold while a reported issue is reviewed.',
    });
  });

  it('closes the second-approval item of a payout that was awaiting one', async () => {
    const h = build();
    h.tx.payout.findMany.mockResolvedValue([
      payoutRow({ status: 'awaiting_second_approval' }),
    ]);

    await hold(h);

    expect(h.effects.approvalCloses).toEqual([
      { kind: 'payout_second', itemId: 'payout-1', reason: 'held' },
    ]);
    expect(h.effects.approvalOpens).toEqual([
      { kind: 'payout', itemId: 'payout-1' },
    ]);
  });

  it('flags a processing transfer for urgent Finance review instead of holding it', async () => {
    const h = build();
    h.tx.payout.findMany.mockResolvedValue([
      payoutRow({ id: 'payout-9', status: 'processing' }),
    ]);

    await expect(hold(h)).resolves.toEqual({
      held: [],
      flagged: ['payout-9'],
    });

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-9', status: 'processing' },
      data: {
        holdReason: 'An issue is open on this request.',
        holdSource: 'issue',
        version: { increment: 1 },
      },
    });
    expect(h.effects.audit[0]).toMatchObject({
      action: 'Payout flagged for urgent review',
      data: { changes: { holdSource: 'issue', issueId: 'issue-1' } },
    });
    expect(h.effects.notify[0].event).toBe('payout.needs_attention');
    expect(h.effects.notify.map(({ event }) => event)).not.toContain(
      'payout.held',
    );
  });
});

describe('FinanceService.transferPayout (C-05, C-23, C-43)', () => {
  const approved = {
    status: 'approved',
    approvals: [approvalRow()],
  };
  const paystack = { method: 'paystack' as const };

  it('claims approved to processing and writes the attempt before it calls Paystack', async () => {
    const h = build({ payout: approved });
    asStaff(h, 'finance-1');

    await h.service.transferPayout('finance-1', 'payout-1', paystack, idem);

    expect(h.calls.filter((call) => call !== 'lock')).toEqual([
      'payout.claim',
      'attempt.create',
      'gateway.transfer',
      'attempt.update',
    ]);
    const attempt = h.tx.transferAttempt.create.mock.calls[0][0] as {
      data: { reference: string; status: string; amount: bigint };
    };
    expect(attempt.data.reference).toMatch(TRANSFER_REFERENCE_PATTERN);
    expect(attempt.data).toMatchObject({
      status: 'pending',
      amount: 9_000_000n,
    });
    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'approved' },
      data: {
        status: 'processing',
        transferReference: attempt.data.reference,
        version: { increment: 1 },
      },
    });
    expect(h.gateway.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ reference: attempt.data.reference }),
    );
  });

  it('makes one transfer when a second call loses the claim (count 0)', async () => {
    const h = build({ payout: approved, claim: 0 });
    asStaff(h, 'finance-1');

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This payout is not approved for transfer.',
    });
    expect(h.tx.transferAttempt.create).not.toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
    expect(h.effects.audit).toEqual([]);
  });

  it('refuses a payout that is already processing, pointing to retry', async () => {
    const h = build({ payout: { ...approved, status: 'processing' } });
    asStaff(h, 'finance-1');

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('retry') as string,
    });
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('refuses when the approvals covered other bank details', async () => {
    const h = build({
      payout: {
        ...approved,
        approvals: [approvalRow({ bankVersion: 'bank-0:old' })],
      },
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('keeps the payout processing and the attempt pending after a gateway timeout', async () => {
    const h = build({
      payout: approved,
      transfer: () => {
        h.calls.push('gateway.transfer');
        return Promise.reject(new Error('timeout'));
      },
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).rejects.toThrow('timeout');

    const attemptWrites = h.tx.transferAttempt.updateMany.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    expect(attemptWrites).toEqual([{ failureCode: 'gateway_unconfirmed' }]);
    // The payout is never moved back or to failed.
    expect(h.tx.payout.updateMany).toHaveBeenCalledTimes(1);
    expect(h.effects.notify.map((n) => n.event)).toEqual([
      'payout.needs_attention',
    ]);
    expect(h.idempotency.store).not.toHaveBeenCalled();
  });

  it('fails the attempt and the payout when Paystack refuses the transfer', async () => {
    const h = build({
      payout: approved,
      transfer: () => Promise.reject(new GatewayRejectedError('No balance')),
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).rejects.toBeInstanceOf(GatewayRejectedError);

    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-new', status: 'pending' },
      data: expect.objectContaining({
        status: 'failed',
        failureCode: 'gateway_rejected',
      }) as unknown,
    });
    expect(h.tx.payout.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'payout-1', status: 'processing' },
      data: { status: 'failed', version: { increment: 1 } },
    });
    expect(h.effects.notify.map((n) => n.event)).toEqual([
      'payout.failed',
      'payout.finance_update',
    ]);
  });

  it('marks the attempt failed when Paystack answers failed and a verify confirms it', async () => {
    const h = build({
      payout: approved,
      transfer: () => Promise.resolve({ transferId: 'gw-1', status: 'failed' }),
      verifyTransfer: () =>
        Promise.resolve({ reference: 'x', status: 'failed' }),
    });
    asStaff(h, 'finance-1');

    await h.service.transferPayout('finance-1', 'payout-1', paystack, idem);

    expect(h.gateway.verifyTransfer).toHaveBeenCalled();
    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-new', status: 'pending' },
      data: expect.objectContaining({
        status: 'failed',
        gatewayTransferId: 'gw-1',
      }) as unknown,
    });
    expect(h.tx.payout.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'payout-1', status: 'processing' },
      data: { status: 'failed', version: { increment: 1 } },
    });
  });

  it('leaves the payout processing when a synchronous failed is not confirmed', async () => {
    const h = build({
      payout: approved,
      transfer: () => Promise.resolve({ transferId: 'gw-1', status: 'failed' }),
      verifyTransfer: () =>
        Promise.resolve({ reference: 'x', status: 'pending' }),
    });
    asStaff(h, 'finance-1');

    await h.service.transferPayout('finance-1', 'payout-1', paystack, idem);

    expect(h.tx.payout.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-new', status: 'pending' },
      data: expect.objectContaining({ status: 'processing' }) as unknown,
    });
  });

  it('raises a needs-attention notice for Finance when Paystack asks for an OTP', async () => {
    const h = build({
      payout: approved,
      transfer: () => Promise.resolve({ transferId: 'gw-1', status: 'otp' }),
    });
    asStaff(h, 'finance-1');

    await h.service.transferPayout('finance-1', 'payout-1', paystack, idem);

    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-new', status: 'pending' },
      data: expect.objectContaining({
        status: 'otp',
        failureCode: 'otp_required',
      }) as unknown,
    });
    expect(h.effects.notify).toEqual([
      expect.objectContaining({ event: 'payout.needs_attention' }),
    ]);
    expect(h.tx.payout.updateMany).toHaveBeenCalledTimes(1);
  });

  it('replays a stored response for the same Idempotency-Key without touching the payout', async () => {
    const h = build({ payout: approved });
    asStaff(h, 'finance-1');
    h.idempotency.lookup.mockResolvedValue({ status: 200, body: { id: 'p' } });

    await expect(
      h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
    ).resolves.toEqual({ id: 'p' });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('records an offline transfer with a conditional claim and the proof', async () => {
    const h = build({ payout: approved });
    asStaff(h, 'finance-1');

    await h.service.transferPayout(
      'finance-1',
      'payout-1',
      { method: 'offline', reference: 'BANK-REF', proofFileId: 'file-1' },
      idem,
    );

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: 'approved' },
      data: {
        status: 'processing',
        transferReference: 'BANK-REF',
        transferProofId: 'file-1',
        transferRecordedBy: 'finance-1',
        version: { increment: 1 },
      },
    });
    expect(h.uploads.attach).toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });
});

describe('FinanceService.retryTransfer (C-05, 05 §7)', () => {
  // The retry decides on the wall clock before it enters the runner, so only Date is faked.
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'performance',
        'hrtime',
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const processing = {
    status: 'processing',
    approvals: [approvalRow()],
  };
  const retryIdem = {
    key: 'idem-key-12345',
    url: '/admin/payouts/payout-1/retry',
  };

  it('verifies the previous reference with Paystack before anything else', async () => {
    const h = build({ payout: processing });
    asStaff(h, 'finance-1');

    await h.service.retryTransfer('finance-1', 'payout-1', retryIdem);

    expect(h.calls.filter((call) => call !== 'lock')).toEqual([
      'gateway.verify',
      'payout.claim',
      'attempt.update',
      'attempt.create',
      'gateway.transfer',
      'attempt.update',
    ]);
    expect(h.gateway.verifyTransfer).toHaveBeenCalledWith(
      'xpro_tr_' + 'a'.repeat(32),
    );
  });

  it('creates a new attempt with a new reference when Paystack does not know the old one', async () => {
    const h = build({ payout: processing });
    asStaff(h, 'finance-1');

    await h.service.retryTransfer('finance-1', 'payout-1', retryIdem);

    const created = h.tx.transferAttempt.create.mock.calls[0][0] as {
      data: { reference: string };
    };
    expect(created.data.reference).toMatch(TRANSFER_REFERENCE_PATTERN);
    expect(created.data.reference).not.toBe('xpro_tr_' + 'a'.repeat(32));
    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-1', status: { not: 'success' } },
      data: expect.objectContaining({
        status: 'failed',
        failureCode: 'verified_not_found',
      }) as unknown,
    });
    expect(h.gateway.transfer).toHaveBeenCalledTimes(1);
  });

  it('creates a new attempt after Paystack confirms the earlier one failed', async () => {
    const h = build({
      payout: { ...processing, status: 'failed' },
      verifyTransfer: () =>
        Promise.resolve({ reference: 'x', status: 'failed' }),
    });
    asStaff(h, 'finance-1');

    await h.service.retryTransfer('finance-1', 'payout-1', retryIdem);

    expect(h.tx.transferAttempt.create).toHaveBeenCalledTimes(1);
    expect(h.gateway.transfer).toHaveBeenCalledTimes(1);
  });

  it('settles instead of resubmitting when the earlier transfer succeeded', async () => {
    const h = build({
      payout: processing,
      verifyTransfer: () =>
        Promise.resolve({
          reference: 'x',
          status: 'success',
          amount: 9_000_000,
        }),
    });
    asStaff(h, 'finance-1');

    await h.service.retryTransfer('finance-1', 'payout-1', retryIdem);

    expect(h.gateway.transfer).not.toHaveBeenCalled();
    expect(h.tx.transferAttempt.create).not.toHaveBeenCalled();
    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: { in: ['processing', 'failed'] } },
      data: expect.objectContaining({ status: 'paid' }) as unknown,
    });
  });

  it('waits, and creates nothing, while Paystack still reports the transfer on its way', async () => {
    const h = build({
      payout: processing,
      verifyTransfer: () =>
        Promise.resolve({ reference: 'x', status: 'pending' }),
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.transferAttempt.create).not.toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('waits when the first call is only moments old, even though Paystack does not know it yet', async () => {
    const h = build({
      payout: processing,
      latestAttempt: attemptRow({ submittedAt: new Date() }),
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('writes nothing when the verification itself fails', async () => {
    const h = build({
      payout: processing,
      verifyTransfer: () => Promise.reject(new Error('Paystack down')),
    });
    asStaff(h, 'finance-1');

    await expect(
      h.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toThrow('Paystack down');
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });

  it('refuses an offline or settled payout', async () => {
    const offline = build({
      payout: { ...processing, transferRecordedBy: 'finance-9' },
    });
    asStaff(offline, 'finance-1');
    await expect(
      offline.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toMatchObject({ status: 409 });

    const paid = build({ payout: { ...processing, status: 'paid' } });
    asStaff(paid, 'finance-1');
    await expect(
      paid.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is a no-op for the second of two concurrent retries (count 0)', async () => {
    const h = build({ payout: processing, claim: 0 });
    asStaff(h, 'finance-1');

    await expect(
      h.service.retryTransfer('finance-1', 'payout-1', retryIdem),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.transferAttempt.create).not.toHaveBeenCalled();
    expect(h.gateway.transfer).not.toHaveBeenCalled();
  });
});

describe('FinanceService.settleTransferFromGateway (C-19)', () => {
  const settle = (
    h: ReturnType<typeof build>,
    outcome: 'success' | 'failed' | 'reversed',
    extra: { verifiedAmount?: number } = {},
  ) =>
    h.service.settleTransferFromGateway('xpro_tr_' + 'a'.repeat(32), outcome, {
      actor: null,
      ...extra,
    });

  it('marks the payout paid for the latest attempt and notifies the provider and Finance', async () => {
    const h = build({ payout: { status: 'processing' } });

    await expect(settle(h, 'success')).resolves.toEqual({ applied: true });

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: 'payout-1', status: { in: ['processing', 'failed'] } },
      data: { status: 'paid', paidAt: NOW, version: { increment: 1 } },
    });
    expect(h.effects.notify.map((n) => n.event)).toEqual([
      'payout.paid',
      'payout.finance_update',
    ]);
    expect(h.effects.notify[0].params).toMatchObject({
      providerUserId: 'provider-user-1',
      assignmentId: 'assignment-1',
      amount: 9_000_000,
    });
    expect(h.effects.approvalCloses.map((c) => c.kind)).toEqual([
      'payout',
      'payout_second',
    ]);
  });

  it('notifies failed and reversed transfers and opens a Finance item', async () => {
    const failed = build({ payout: { status: 'processing' } });
    await settle(failed, 'failed');
    expect(failed.effects.notify.map((n) => n.event)).toEqual([
      'payout.failed',
      'payout.finance_update',
    ]);
    expect(failed.effects.approvalOpens).toEqual([
      { kind: 'payout', itemId: 'payout-1' },
    ]);

    const reversed = build({ payout: { status: 'paid' } });
    await settle(reversed, 'reversed');
    expect(reversed.effects.notify.map((n) => n.event)).toEqual([
      'payout.reversed',
      'payout.finance_update',
    ]);
  });

  it('does not let a late event for an earlier attempt overwrite a newer one', async () => {
    const h = build({ payout: { status: 'processing' } });
    h.tx.transferAttempt.findFirst.mockResolvedValue({ id: 'attempt-newer' });

    await expect(settle(h, 'failed')).resolves.toEqual({ applied: false });

    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.tx.transferAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-1', status: { not: 'failed' } },
      data: expect.objectContaining({ status: 'failed' }) as unknown,
    });
    expect(h.effects.notify).toEqual([]);
  });

  it('tells Finance when an earlier attempt turns out to have been paid', async () => {
    const h = build({ payout: { status: 'processing' } });
    h.tx.transferAttempt.findFirst.mockResolvedValue({ id: 'attempt-newer' });

    await settle(h, 'success');

    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.effects.notify.map((n) => n.event)).toEqual([
      'payout.needs_attention',
    ]);
  });

  it('leaves the payout alone when the amount does not match', async () => {
    const h = build({ payout: { status: 'processing' } });

    await expect(
      settle(h, 'success', { verifiedAmount: 1_000 }),
    ).resolves.toEqual({ applied: false });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
  });

  it('is a duplicate no-op when the attempt already has that status', async () => {
    const h = build({ payout: { status: 'paid' } });
    h.tx.transferAttempt.updateMany.mockResolvedValue({ count: 0 });

    await expect(settle(h, 'success')).resolves.toEqual({ applied: false });

    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
    expect(h.effects.notify).toEqual([]);
    expect(h.effects.audit).toEqual([]);
  });

  it('runs the inbox callback in the same transaction even for a duplicate', async () => {
    const h = build({ payout: { status: 'paid' } });
    h.tx.transferAttempt.updateMany.mockResolvedValue({ count: 0 });
    const onSettled = jest.fn().mockResolvedValue(undefined);

    await h.service.settleTransferFromGateway(
      'xpro_tr_' + 'a'.repeat(32),
      'success',
      { actor: null, onSettled },
    );

    expect(onSettled).toHaveBeenCalledWith(h.tx);
  });

  it('ignores a reference it does not know', async () => {
    const h = build({ latestAttempt: null });

    await expect(settle(h, 'success')).resolves.toEqual({ applied: false });
    expect(h.runs).toEqual([]);
  });
});

describe('FinanceService.reconcilePayout', () => {
  const offline = { status: 'processing', transferRecordedBy: 'finance-1' };

  it('refuses the person who recorded the transfer with 403', async () => {
    const h = build({ payout: offline });
    asStaff(h, 'finance-1');

    await expect(
      h.service.reconcilePayout('finance-1', 'payout-1', 'Seen on statement.'),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
  });

  it('marks the payout paid for a second person with a conditional claim', async () => {
    const h = build({ payout: offline });
    asStaff(h, 'finance-2');

    await h.service.reconcilePayout(
      'finance-2',
      'payout-1',
      'Seen on statement.',
    );

    expect(h.tx.payout.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payout-1',
        status: 'processing',
        transferRecordedBy: { not: 'finance-2' },
      },
      data: {
        status: 'paid',
        paidAt: NOW,
        reconciledBy: 'finance-2',
        version: { increment: 1 },
      },
    });
    expect(h.effects.notify.map((n) => n.event)).toContain('payout.paid');
  });
});

describe('FinanceService.closureState (C-18)', () => {
  it('counts only the primary payout, and a cancelled one does not satisfy closure', async () => {
    const h = build();
    h.tx.payout.findMany.mockResolvedValue([
      { kind: 'primary', status: 'cancelled', holdReason: null },
    ]);

    await expect(
      h.service.closureState(h.tx as never, 'request-1'),
    ).resolves.toMatchObject({ state: 'blocked' });
    expect(h.tx.payout.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1' },
      select: { kind: true, status: true, holdReason: true },
    });
  });

  it('is satisfied by a paid payout or a held one with a reason', async () => {
    const h = build();
    h.tx.payout.findMany.mockResolvedValue([
      { kind: 'primary', status: 'paid', holdReason: null },
    ]);
    await expect(
      h.service.closureState(h.tx as never, 'request-1'),
    ).resolves.toEqual({ state: 'paid' });

    h.tx.payout.findMany.mockResolvedValue([
      { kind: 'primary', status: 'on_hold', holdReason: 'Open customer issue' },
    ]);
    await expect(
      h.service.closureState(h.tx as never, 'request-1'),
    ).resolves.toMatchObject({ state: 'on_hold_with_reason' });
  });
});

describe('FinanceService queues (C-41, C-42, E-27)', () => {
  it('lists payouts as allow-list rows filtered by status, with the amount masked without view.pricing', async () => {
    const h = build();
    asStaff(h, 'finance-1', ['payout.approve']);
    h.prisma.payout.findMany.mockResolvedValue([
      payoutRow({ transferProofId: 'proof-secret' }),
    ]);
    h.prisma.payout.count.mockResolvedValue(1);
    h.prisma.providerProfile.findMany.mockResolvedValue([
      { id: 'provider-1', businessName: 'Ada Plumbing' },
    ]);

    const page = await h.service.payouts('finance-1', {
      page: 1,
      status: 'approved',
    });

    expect(h.prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'approved' } }),
    );
    expect(page.items[0]).toMatchObject({
      amount: null,
      providerName: 'Ada Plumbing',
      maskedBankAccount: '•••• 1234',
    });
    expect(JSON.stringify(page)).not.toContain('proof-secret');
  });

  it('refuses an unknown status filter with 422', async () => {
    const h = build();
    asStaff(h, 'finance-1');

    await expect(
      h.service.payouts('finance-1', { status: 'bogus' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('returns the provider masked bank, a safe hold reason and paging on earnings', async () => {
    const h = build();
    const prisma = h.prisma as unknown as Record<
      string,
      Record<string, jest.Mock>
    >;
    prisma.providerProfile.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'provider-1' });
    prisma.payout.groupBy = jest.fn().mockResolvedValue([
      { status: 'paid', _sum: { amount: 5_000_000n } },
      { status: 'on_hold', _sum: { amount: 4_000_000n } },
      { status: 'cancelled', _sum: { amount: 1_000_000n } },
    ]);
    prisma.providerBankAccount.findFirst = jest
      .fn()
      .mockResolvedValue({ last4: '9876' });
    prisma.payout.findMany.mockResolvedValue([
      payoutRow({
        status: 'on_hold',
        holdSource: 'issue',
        holdReason: 'Internal note about the customer.',
        bankLast4: null,
      }),
    ]);
    prisma.payout.count.mockResolvedValue(30);

    const result = await h.service.earnings('provider-user-1', 2);

    expect(result).toMatchObject({
      totalPaid: 5_000_000,
      totalPending: 4_000_000,
      page: 2,
      limit: 25,
      total: 30,
      totalPages: 2,
      hasNextPage: false,
      hasPrevPage: true,
    });
    expect(result.payouts[0]).toMatchObject({
      maskedBankAccount: '•••• 9876',
      holdReason: 'On hold while a reported issue is reviewed.',
    });
    expect(JSON.stringify(result)).not.toContain('Internal note');
    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
  });
});

describe('payout audit rows, notices and versions (C-21, C-24, C-46)', () => {
  type Row = {
    resourceType: string;
    resourceId: string;
    note?: string;
    changes: { before: unknown; after: unknown; [key: string]: unknown };
  };
  const auditRow = (h: ReturnType<typeof build>, action: string): Row => {
    const found = h.effects.audit.find((entry) => entry.action === action);
    if (!found) throw new Error(`No audit row "${action}"`);
    return found.data as Row;
  };
  const events = (h: ReturnType<typeof build>) =>
    h.effects.notify.map(({ event }) => event);
  const approved = { status: 'approved', approvals: [approvalRow()] };
  const awaiting = {
    status: 'awaiting_second_approval',
    approvals: [approvalRow()],
  };
  const paystack = { method: 'paystack' as const };

  it.each([
    [
      'approve',
      'Payout approved',
      {},
      'finance-1',
      (h: ReturnType<typeof build>) =>
        h.service.approvePayout('finance-1', 'payout-1', 'Fine.'),
      'approved',
    ],
    [
      'second approval',
      'Payout second approval given',
      awaiting,
      'finance-2',
      (h: ReturnType<typeof build>) =>
        h.service.secondApprovePayout('finance-2', 'payout-1', true, 'OK.'),
      'approved',
    ],
    [
      'hold',
      'Payout held',
      { status: 'approved' },
      'finance-1',
      (h: ReturnType<typeof build>) =>
        h.service.payoutHold('finance-1', 'payout-1', true, 'Checking bank.'),
      'on_hold',
    ],
    [
      'release',
      'Payout released',
      { status: 'on_hold', holdSource: 'manual', holdReason: 'x' },
      'finance-1',
      (h: ReturnType<typeof build>) =>
        h.service.payoutHold('finance-1', 'payout-1', false, 'Resolved.'),
      'pending_approval',
    ],
    [
      'Paystack transfer',
      'Payout transfer started',
      approved,
      'finance-1',
      (h: ReturnType<typeof build>) =>
        h.service.transferPayout('finance-1', 'payout-1', paystack, idem),
      'processing',
    ],
    [
      'offline transfer',
      'Payout offline transfer recorded',
      approved,
      'finance-1',
      (h: ReturnType<typeof build>) =>
        h.service.transferPayout(
          'finance-1',
          'payout-1',
          { method: 'offline', reference: 'BANK-REF', proofFileId: 'file-1' },
          idem,
        ),
      'processing',
    ],
    [
      'reconcile',
      'Payout reconciled',
      { status: 'processing', transferRecordedBy: 'finance-1' },
      'finance-2',
      (h: ReturnType<typeof build>) =>
        h.service.reconcilePayout('finance-2', 'payout-1', 'Seen.'),
      'paid',
    ],
  ])(
    '%s writes one audit row with the actor, resource, before and after',
    async (_name, action, payout, userId, run, after) => {
      const h = build({ payout });
      asStaff(h, userId);

      await run(h);

      const row = auditRow(h, action);
      expect(row).toMatchObject({
        resourceType: 'payout',
        resourceId: 'payout-1',
        changes: {
          before: { amount: 9_000_000 },
          after: { status: after, amount: 9_000_000 },
        },
      });
      expect(h.runs[0]).toBeDefined();
      expect(JSON.stringify(row)).not.toMatch(/account|plain:|enc:/i);
    },
  );

  it('settling a transfer from Paystack audits the system action with the reference', async () => {
    const h = build({ payout: { status: 'processing' } });

    await h.service.settleTransferFromGateway(
      'xpro_tr_' + 'a'.repeat(32),
      'success',
      { actor: null },
    );

    expect(auditRow(h, 'Payout paid').changes).toMatchObject({
      reference: 'xpro_tr_' + 'a'.repeat(32),
      before: { status: 'processing' },
      after: { status: 'paid' },
    });
  });

  describe('retry', () => {
    beforeEach(() => {
      jest.useFakeTimers({
        now: NOW,
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
          'queueMicrotask',
          'performance',
          'hrtime',
        ],
      });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('audits the new attempt with the previous reference', async () => {
      const h = build({
        payout: { status: 'processing', approvals: [approvalRow()] },
      });
      asStaff(h, 'finance-1');

      await h.service.retryTransfer('finance-1', 'payout-1', {
        key: 'idem-key-12345',
        url: '/admin/payouts/payout-1/retry',
      });

      expect(auditRow(h, 'Payout transfer retried').changes).toMatchObject({
        previousReference: 'xpro_tr_' + 'a'.repeat(32),
        before: { status: 'processing' },
        after: { status: 'processing' },
      });
    });
  });

  it('creation audits from nothing and tells Finance the payout is ready, with a due date', async () => {
    const h = build({
      settings: {
        'calendar.holidays': [],
        'approvals.deadlines': { payout: 1200 },
      },
    });

    await h.service.createPrimary(h.ctx, {
      requestId: 'request-1',
      assignmentId: 'assignment-1',
      providerId: 'provider-1',
      amount: 9_000_000n,
      payoutAssignmentId: 'assignment-1',
    });

    expect(auditRow(h, 'Payout created')).toMatchObject({
      resourceId: 'payout-new',
      changes: {
        before: null,
        after: { status: 'pending_approval', amount: 9_000_000 },
      },
    });
    expect(h.effects.notify).toEqual([
      {
        event: 'payout.created',
        params: {
          requestCode: 'XPR-00042',
          amount: 9_000_000,
          dueDate: '28/10/2026',
          onHold: false,
        },
      },
    ]);
  });

  it('creation on hold tells the provider with a safe reason only', async () => {
    const h = build({
      settings: {
        'calendar.holidays': [],
        'approvals.deadlines': { payout: 1200 },
      },
      issues: ['open'],
    });

    await h.service.createPrimary(h.ctx, {
      requestId: 'request-1',
      assignmentId: 'assignment-1',
      providerId: 'provider-1',
      amount: 9_000_000n,
      payoutAssignmentId: 'assignment-1',
    });

    expect(events(h)).toEqual(['payout.created', 'payout.held']);
    expect(h.effects.notify[1].params).toEqual({
      requestCode: 'XPR-00042',
      assignmentId: 'assignment-1',
      providerUserId: 'provider-user-1',
      reason: 'On hold while a reported issue is reviewed.',
    });
  });

  it('a first approval above the threshold asks eligible second approvers', async () => {
    const h = build({
      settings: { 'payout.secondApprovalThreshold': 8_999_999 },
    });
    asStaff(h, 'finance-1');

    await h.service.approvePayout('finance-1', 'payout-1');

    expect(h.effects.notify).toEqual([
      {
        event: 'payout.second_approval_needed',
        params: { requestCode: 'XPR-00042', amount: 9_000_000 },
      },
    ]);
  });

  it('a hold tells the provider why in safe words, and Finance', async () => {
    const h = build({ payout: { status: 'approved' } });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', true, 'Private note.');

    expect(h.effects.notify).toEqual([
      {
        event: 'payout.held',
        params: {
          requestCode: 'XPR-00042',
          assignmentId: 'assignment-1',
          providerUserId: 'provider-user-1',
          reason: 'On hold while XPro Finance reviews this payout.',
        },
      },
      {
        event: 'payout.finance_update',
        params: {
          requestCode: 'XPR-00042',
          amount: 9_000_000,
          outcome: 'held',
        },
      },
    ]);
    expect(JSON.stringify(h.effects.notify)).not.toContain('Private note.');
  });

  it('a release tells the provider and Finance', async () => {
    const h = build({
      payout: { status: 'on_hold', holdSource: 'manual', holdReason: 'x' },
    });
    asStaff(h, 'finance-1');

    await h.service.payoutHold('finance-1', 'payout-1', false, 'Resolved.');

    expect(events(h)).toEqual(['payout.released', 'payout.finance_update']);
    expect(h.effects.notify[1].params).toMatchObject({ outcome: 'released' });
  });

  describe('If-Match', () => {
    const stale = { version: 5 };
    const conflict = {
      status: 409,
      code: 'VERSION_CONFLICT',
      message: 'This record has changed. Refresh and retry.',
    };

    it.each([
      [
        'approve',
        {},
        'finance-1',
        (h: ReturnType<typeof build>) =>
          h.service.approvePayout('finance-1', 'payout-1', undefined, 4),
      ],
      [
        'second approval',
        awaiting,
        'finance-2',
        (h: ReturnType<typeof build>) =>
          h.service.secondApprovePayout(
            'finance-2',
            'payout-1',
            true,
            'OK.',
            4,
          ),
      ],
      [
        'hold',
        { status: 'approved' },
        'finance-1',
        (h: ReturnType<typeof build>) =>
          h.service.payoutHold('finance-1', 'payout-1', true, 'Why.', 4),
      ],
      [
        'release',
        { status: 'on_hold', holdSource: 'manual' },
        'finance-1',
        (h: ReturnType<typeof build>) =>
          h.service.payoutHold('finance-1', 'payout-1', false, 'Done.', 4),
      ],
      [
        'Paystack transfer',
        approved,
        'finance-1',
        (h: ReturnType<typeof build>) =>
          h.service.transferPayout('finance-1', 'payout-1', paystack, idem, 4),
      ],
      [
        'offline transfer',
        approved,
        'finance-1',
        (h: ReturnType<typeof build>) =>
          h.service.transferPayout(
            'finance-1',
            'payout-1',
            { method: 'offline', reference: 'R', proofFileId: 'f' },
            idem,
            4,
          ),
      ],
      [
        'reconcile',
        { status: 'processing', transferRecordedBy: 'finance-1' },
        'finance-2',
        (h: ReturnType<typeof build>) =>
          h.service.reconcilePayout('finance-2', 'payout-1', 'Seen.', 4),
      ],
    ])(
      '%s refuses a stale version and changes nothing',
      async (_n, payout, userId, run) => {
        const h = build({ payout: { ...payout, ...stale } });
        asStaff(h, userId);

        await expect(run(h)).rejects.toMatchObject(conflict);

        expect(h.tx.payout.updateMany).not.toHaveBeenCalled();
        expect(h.effects.audit).toEqual([]);
        expect(h.gateway.transfer).not.toHaveBeenCalled();
      },
    );

    it('goes ahead when the version matches or no If-Match is sent, and every claim bumps it', async () => {
      for (const expected of [5, undefined]) {
        const h = build({ payout: { status: 'approved', version: 5 } });
        asStaff(h, 'finance-1');

        await h.service.payoutHold(
          'finance-1',
          'payout-1',
          true,
          'Checking.',
          expected,
        );

        expect(h.tx.payout.updateMany.mock.calls[0][0]).toMatchObject({
          data: { version: { increment: 1 } },
        });
      }
    });
  });
});
