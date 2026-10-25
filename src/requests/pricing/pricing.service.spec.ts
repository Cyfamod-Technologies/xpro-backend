import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ActorContext } from '../../platform/actor/actor.types';
import type { CommandContext } from '../command-runner';
import { PricingService } from './pricing.service';
import { QuoteDecisionDto } from './pricing.dto';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const DAY = 86_400_000;
const URL = '/requests/XPR-00001/quotes/quote-1';

const sentV1 = {
  id: 'quote-1',
  requestId: 'request-1',
  version: 1,
  status: 'sent',
  total: 500_000n,
  validUntil: new Date('2026-11-30T00:00:00.000Z'),
};

type Call = Record<string, jest.Mock>;
type Tx = Record<string, Call>;

const actor = (
  kind: ActorContext['kind'],
  options: {
    userId?: string;
    permissions?: string[];
    isSuperAdmin?: boolean;
  } = {},
) =>
  ({
    userId: options.userId ?? `${kind}-1`,
    kind,
    displayName: 'Test',
    accountActive: true,
    platformRoles: [kind],
    ...(kind === 'staff'
      ? {
          staff: {
            status: 'active',
            roles: [],
            permissions: new Set(options.permissions ?? []),
            canOwn: true,
            isSuperAdmin: options.isSuperAdmin ?? false,
            permVersion: 1,
          },
        }
      : {}),
  }) as unknown as ActorContext;

function harness(options: {
  actor: ActorContext;
  snap?: Record<string, unknown>;
  tx?: Tx;
  prisma?: Tx;
  settings?: Record<string, unknown>;
}) {
  const effects = {
    audit: [] as Array<{ action: string; data?: Record<string, unknown> }>,
    notify: [] as Array<{ event: string; params: Record<string, unknown> }>,
    timerStarts: [] as Array<{ kind: string; dueAt: Date; refId?: string }>,
    timerStops: [] as Array<{ kind: unknown; refId?: string }>,
  };
  const tx: Tx = {
    quote: {
      findFirst: jest.fn().mockResolvedValue(sentV1),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    serviceRequest: { update: jest.fn().mockResolvedValue({}) },
    cancellation: {
      create: jest.fn().mockResolvedValue({ id: 'cancellation-1' }),
    },
    assignment: { findFirst: jest.fn().mockResolvedValue({ id: 'assign-1' }) },
    contribution: { findFirst: jest.fn().mockResolvedValue({ id: 'cost-1' }) },
    staffMember: { findMany: jest.fn().mockResolvedValue([]) },
    ...options.tx,
  };
  const ctx = {
    tx,
    snap: {
      id: 'request-1',
      number: 'XPR-00001',
      status: 'quoted',
      payment: { paid: false, pendingPaymentAt: null, offlineRecorded: false },
      ...options.snap,
    },
    actor: options.actor,
    now: NOW,
    settings: options.settings ?? {},
    audit: (action: string, data?: Record<string, unknown>) =>
      effects.audit.push({ action, data }),
    notify: (event: string, params: Record<string, unknown>) =>
      effects.notify.push({ event, params }),
    timers: {
      start: (kind: string, dueAt: Date, refId?: string) =>
        effects.timerStarts.push({ kind, dueAt, refId }),
      stop: (kind: unknown, refId?: string) =>
        effects.timerStops.push({ kind, refId }),
    },
    approvals: { open: jest.fn(), close: jest.fn() },
  } as unknown as CommandContext;
  const runner = {
    run: jest.fn(
      (_options: unknown, fn: (c: CommandContext) => Promise<unknown>) =>
        fn(ctx),
    ),
  };
  const prisma: Tx = {
    serviceRequest: {
      findUnique: jest.fn((args: { where: { number?: number } }) =>
        Promise.resolve(
          args.where.number
            ? { id: 'request-1' }
            : { id: 'request-1', ownerId: 'customer-1' },
        ),
      ),
    },
    quote: { findMany: jest.fn().mockResolvedValue([]) },
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    contribution: { findMany: jest.fn().mockResolvedValue([]) },
    ...options.prisma,
  };
  const service = new PricingService(
    prisma as never,
    { resolve: jest.fn().mockResolvedValue(options.actor) } as never,
    runner as never,
  );
  return { service, tx, prisma, effects, ctx };
}

const updateData = (mock: jest.Mock, call = 0) =>
  (mock.mock.calls[call] as [{ data: Record<string, unknown> }])[0].data;

describe('quote.respond', () => {
  const customer = actor('customer', { userId: 'customer-1' });
  const respond = (
    service: PricingService,
    dto: { decision: string; note?: string },
  ) =>
    service.respond(
      { id: 'customer-1' } as never,
      'XPR-00001',
      'quote-1',
      dto as never,
      undefined,
      `${URL}/respond`,
    );
  const withSent = {
    latestQuote: { status: 'sent', version: 1 },
    latestSentQuote: { status: 'sent', version: 1 },
  };

  it('accepts the sent v1 while a v2 draft exists', async () => {
    const { service, tx } = harness({
      actor: customer,
      snap: {
        latestQuote: { status: 'draft', version: 2 },
        latestSentQuote: { status: 'sent', version: 1 },
      },
    });
    await respond(service, { decision: 'accepted' });
    expect(tx.quote.update).toHaveBeenCalledTimes(1);
    expect(updateData(tx.quote.update).status).toBe('accepted');
  });

  it('refuses a sent quote that a newer sent version replaced', async () => {
    const { service, tx } = harness({
      actor: customer,
      snap: {
        latestQuote: { status: 'sent', version: 2 },
        latestSentQuote: { status: 'sent', version: 2 },
      },
    });
    await expect(respond(service, { decision: 'accepted' })).rejects.toThrow(
      'This quote has already changed or received a response.',
    );
    expect(tx.quote.update).not.toHaveBeenCalled();
  });

  describe('accept (B-22)', () => {
    it('sets respondedAt, due date from payment.dueDays, status and T9', async () => {
      const { service, tx, effects } = harness({
        actor: customer,
        snap: withSent,
        settings: { 'payment.dueDays': 10 },
      });
      await respond(service, { decision: 'accepted', note: ' Looks fine ' });
      const dueAt = new Date(NOW.getTime() + 10 * DAY);
      expect(updateData(tx.quote.update)).toMatchObject({
        status: 'accepted',
        respondedAt: NOW,
        acceptedAt: NOW,
        paymentDueAt: dueAt,
        responseNote: 'Looks fine',
      });
      expect(updateData(tx.serviceRequest.update)).toEqual({
        status: 'awaiting_payment',
      });
      expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
        'T9.reminder24h',
        'T9.reminder72h',
        'T9.lapse',
      ]);
      expect(effects.timerStarts[2].dueAt).toEqual(dueAt);
      expect(effects.timerStops[0].kind).toEqual([
        'T8.reminder3d',
        'T8.reminder1d',
        'T8.expire',
      ]);
      expect(effects.audit[0].action).toBe('Quote accepted');
    });

    it('defaults to seven days', async () => {
      const { service, tx } = harness({ actor: customer, snap: withSent });
      await respond(service, { decision: 'accepted' });
      expect(updateData(tx.quote.update).paymentDueAt).toEqual(
        new Date(NOW.getTime() + 7 * DAY),
      );
    });

    it('notifies the customer, the owner and Finance, and the provider', async () => {
      const { service, effects } = harness({
        actor: customer,
        snap: withSent,
      });
      await respond(service, { decision: 'accepted' });
      expect(effects.notify.map(({ event }) => event)).toEqual([
        'quote.payment_due',
        'quote.accepted',
        'quote.accepted_provider',
      ]);
      expect(effects.notify[0].params).toMatchObject({
        requestCode: 'XPR-00001',
        amount: 500_000,
      });
    });
  });

  describe('revision request', () => {
    it('moves the request back to matched and tells staff and the provider', async () => {
      const { service, tx, effects } = harness({
        actor: customer,
        snap: withSent,
      });
      await respond(service, {
        decision: 'revision_requested',
        note: 'Lower the labour cost.',
      });
      expect(updateData(tx.quote.update)).toMatchObject({
        status: 'revision_requested',
        respondedAt: NOW,
        responseNote: 'Lower the labour cost.',
      });
      expect(updateData(tx.serviceRequest.update)).toEqual({
        status: 'matched',
      });
      expect(effects.notify.map(({ event }) => event)).toEqual([
        'quote.revision_requested',
        'quote.changes_requested_provider',
      ]);
      expect(tx.cancellation.create).not.toHaveBeenCalled();
    });
  });

  describe('decline (B-21)', () => {
    it('declines to matched with exactly one pending cancellation and T19', async () => {
      const { service, tx, effects } = harness({
        actor: customer,
        snap: withSent,
      });
      await respond(service, { decision: 'declined', note: 'Too expensive.' });
      expect(updateData(tx.quote.update)).toMatchObject({
        status: 'declined',
        respondedAt: NOW,
      });
      expect(updateData(tx.serviceRequest.update)).toEqual({
        status: 'matched',
      });
      expect(tx.cancellation.create).toHaveBeenCalledTimes(1);
      expect(tx.cancellation.create.mock.calls[0]).toEqual([
        {
          data: {
            requestId: 'request-1',
            requestedBy: 'customer',
            requestedById: 'customer-1',
            reasonCode: 'quote_declined',
            note: 'Too expensive.',
            stage: 'quoted',
            paid: false,
          },
        },
      ]);
      expect(effects.timerStarts).toEqual([
        {
          kind: 'T19.followup',
          dueAt: new Date(NOW.getTime() + 48 * 3_600_000),
          refId: 'cancellation-1',
        },
      ]);
      expect(effects.notify).toEqual([
        { event: 'quote.declined', params: { requestCode: 'XPR-00001' } },
      ]);
      expect(effects.audit.map(({ action }) => action)).toEqual([
        'Quote declined',
        'Cancellation requested',
      ]);
    });
  });

  describe('decision validation (B-20)', () => {
    it('does not decline or cancel for an unknown decision', async () => {
      const { service, tx } = harness({ actor: customer, snap: withSent });
      await expect(
        respond(service, { decision: 'maybe', note: 'Not sure' }),
      ).rejects.toThrow('Choose accept, decline or request a revision.');
      expect(tx.quote.update).not.toHaveBeenCalled();
      expect(tx.cancellation.create).not.toHaveBeenCalled();
    });

    it('rejects anything but the three decisions in the DTO', async () => {
      const errors = await validate(
        plainToInstance(QuoteDecisionDto, { decision: 'maybe', note: 'x' }),
      );
      expect(errors[0].constraints?.isIn).toBe(
        'Choose accept, decline or request a revision.',
      );
      for (const decision of ['accepted', 'revision_requested', 'declined'])
        await expect(
          validate(plainToInstance(QuoteDecisionDto, { decision })),
        ).resolves.toEqual([]);
    });
  });
});

describe('sign-off (B-15, B-16, B-17, B-43)', () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    id: 'quote-1',
    requestId: 'request-1',
    version: 3,
    revision: 2,
    status: 'draft',
    total: 500_000n,
    lastEditedBy: 'staff-1',
    basedOnAssignmentId: 'assign-1',
    pricingOverrideNote: null,
    customerNote: null,
    approvalRequestedAt: null,
    ...overrides,
  });
  const quoteTx = (row: Record<string, unknown>) => ({
    quote: {
      findFirst: jest.fn((args?: { select?: unknown }) =>
        Promise.resolve(args?.select ? { id: row.id } : row),
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
  });
  const publish = (service: PricingService, userId: string, dto = {}) =>
    service.publish(
      userId,
      'XPR-00001',
      'quote-1',
      { revision: 2, ...dto },
      undefined,
      `${URL}/publish`,
    );
  const approve = (service: PricingService, userId: string, dto = {}) =>
    service.approve(
      userId,
      'XPR-00001',
      'quote-1',
      { revision: 2, ...dto },
      undefined,
      `${URL}/approve`,
    );
  const threshold = { 'quote.approvalThreshold': 100_000 };
  const published = (tx: Tx) =>
    tx.quote.update.mock.calls.some(
      ([args]: [{ data: { status?: string } }]) => args.data.status === 'sent',
    );

  describe('publish', () => {
    it('holds a quote at the threshold for a plain quote.manage holder and persists both notes', async () => {
      const row = draft();
      const { service, tx, effects } = harness({
        actor: actor('staff', {
          userId: 'staff-2',
          permissions: ['quote.manage'],
        }),
        tx: quoteTx(row),
        settings: threshold,
      });
      const result = await publish(service, 'staff-2', {
        pricingOverrideNote: ' Urgent job ',
        customerNote: ' Replaces v2 ',
      });
      expect(result).toEqual({ status: 202 });
      expect(published(tx)).toBe(false);
      expect(updateData(tx.quote.update)).toMatchObject({
        approvalRequestedBy: 'staff-2',
        approvalRequestedAt: NOW,
        pricingOverrideNote: 'Urgent job',
        customerNote: 'Replaces v2',
      });
      expect(effects.audit[0]).toMatchObject({
        action: 'Quote approval requested',
        data: { changes: { version: 3 } },
      });
      expect(JSON.stringify(effects.audit[0])).not.toContain('Replaces v2');
      expect(effects.notify.map(({ event }) => event)).toEqual([
        'quote.approval_needed',
      ]);
    });

    it('holds a quote the approver edited last (B-16)', async () => {
      const { service, tx } = harness({
        actor: actor('staff', {
          userId: 'staff-1',
          permissions: ['quote.manage', 'quote.approve'],
        }),
        tx: quoteTx(draft()),
        settings: threshold,
      });
      expect(await publish(service, 'staff-1')).toEqual({ status: 202 });
      expect(published(tx)).toBe(false);
    });

    it('publishes directly for an approver who is not the last editor', async () => {
      const { service, tx, effects } = harness({
        actor: actor('staff', {
          userId: 'approver-1',
          permissions: ['quote.manage', 'quote.approve'],
        }),
        tx: quoteTx(draft()),
        settings: threshold,
      });
      expect(await publish(service, 'approver-1')).toBeUndefined();
      expect(published(tx)).toBe(true);
      expect(effects.audit.map(({ action }) => action)).toEqual([
        'Quote published',
      ]);
    });

    it('publishes directly below the threshold or with the rule off', async () => {
      for (const settings of [
        {},
        { 'quote.approvalThreshold': null },
        { 'quote.approvalThreshold': 500_001 },
      ]) {
        const { service, tx } = harness({
          actor: actor('staff', {
            userId: 'staff-2',
            permissions: ['quote.manage'],
          }),
          tx: quoteTx(draft()),
          settings,
        });
        await publish(service, 'staff-2');
        expect(published(tx)).toBe(true);
      }
    });

    it('keeps the stored override note when none is supplied (B-15)', async () => {
      const { service, tx } = harness({
        actor: actor('staff', {
          userId: 'staff-2',
          permissions: ['quote.manage'],
        }),
        tx: quoteTx(draft({ pricingOverrideNote: 'Held earlier' })),
      });
      await publish(service, 'staff-2');
      expect(updateData(tx.quote.update).pricingOverrideNote).toBe(
        'Held earlier',
      );
    });
  });

  describe('approve', () => {
    const held = (overrides: Record<string, unknown> = {}) =>
      draft({ approvalRequestedAt: NOW, ...overrides });
    const approver = (userId = 'approver-1', isSuperAdmin = false) =>
      actor('staff', {
        userId,
        permissions: ['quote.approve'],
        isSuperAdmin,
      });

    it('reuses the held notes, so a no-costing quote held in awaiting_payment can be approved (B-15)', async () => {
      const { service, tx, effects } = harness({
        actor: approver(),
        snap: { status: 'awaiting_payment' },
        tx: {
          ...quoteTx(
            held({
              pricingOverrideNote: 'No costing: urgent',
              customerNote: 'Replaces v2',
            }),
          ),
          contribution: { findFirst: jest.fn().mockResolvedValue(null) },
        },
      });
      await approve(service, 'approver-1');
      expect(updateData(tx.quote.update, 0)).toMatchObject({
        status: 'sent',
        pricingOverrideNote: 'No costing: urgent',
      });
      expect(effects.notify).toContainEqual({
        event: 'quote.ready',
        params: { requestCode: 'XPR-00001', note: 'Replaces v2' },
      });
      expect(updateData(tx.quote.update, 0).customerNote).toBeNull();
    });

    it('writes one Quote approved audit and no publish audit (B-43)', async () => {
      const { service, tx, effects } = harness({
        actor: approver(),
        tx: quoteTx(held()),
      });
      await approve(service, 'approver-1');
      expect(effects.audit.map(({ action }) => action)).toEqual([
        'Quote approved',
      ]);
      expect(effects.audit[0].data).toMatchObject({
        changes: { version: 3, selfApproved: false },
      });
      expect(effects.audit[0].data).not.toHaveProperty('flags');
      expect(updateData(tx.quote.update, 1)).toEqual({
        approvedBy: 'approver-1',
        selfApproved: false,
      });
      expect(tx.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('still needs costing or an override note', async () => {
      const { service } = harness({
        actor: approver(),
        tx: {
          ...quoteTx(held()),
          contribution: { findFirst: jest.fn().mockResolvedValue(null) },
        },
      });
      await expect(approve(service, 'approver-1')).rejects.toThrow(
        "Get the provider's costing first, or add a pricing override note.",
      );
    });

    it('refuses the last editor when another super admin is active (B-17)', async () => {
      const { service } = harness({
        actor: approver('staff-1', true),
        tx: {
          ...quoteTx(held()),
          staffMember: {
            findMany: jest
              .fn()
              .mockResolvedValue([
                { userId: 'staff-1' },
                { userId: 'staff-2' },
              ]),
          },
        },
      });
      await expect(
        approve(service, 'staff-1', { selfApprovalReason: 'Urgent' }),
      ).rejects.toThrow(
        'You edited this quote last. Another approver must sign it off.',
      );
    });

    it('refuses a last editor who is not a super admin even with a reason', async () => {
      const { service } = harness({
        actor: approver('staff-1'),
        tx: {
          ...quoteTx(held()),
          staffMember: {
            findMany: jest.fn().mockResolvedValue([{ userId: 'staff-1' }]),
          },
        },
      });
      await expect(
        approve(service, 'staff-1', { selfApprovalReason: 'Urgent' }),
      ).rejects.toThrow('You edited this quote last.');
    });

    it('asks the sole super admin for a reason', async () => {
      const { service, tx } = harness({
        actor: approver('staff-1', true),
        tx: {
          ...quoteTx(held()),
          staffMember: {
            findMany: jest.fn().mockResolvedValue([{ userId: 'staff-1' }]),
          },
        },
      });
      await expect(approve(service, 'staff-1')).rejects.toThrow(
        'Add a reason for approving your own quote.',
      );
      expect(published(tx)).toBe(false);
    });

    it('lets the sole super admin approve their own quote, flagged self_approved', async () => {
      const { service, tx, effects } = harness({
        actor: approver('staff-1', true),
        tx: {
          ...quoteTx(held()),
          staffMember: {
            findMany: jest.fn().mockResolvedValue([{ userId: 'staff-1' }]),
          },
        },
      });
      await approve(service, 'staff-1', {
        selfApprovalReason: ' Only admin on duty ',
      });
      expect(published(tx)).toBe(true);
      expect(updateData(tx.quote.update, 1)).toEqual({
        approvedBy: 'staff-1',
        selfApproved: true,
      });
      expect(effects.audit).toEqual([
        {
          action: 'Quote approved',
          data: {
            resourceType: 'quote',
            resourceId: 'quote-1',
            note: 'Only admin on duty',
            changes: { version: 3, selfApproved: true },
            flags: ['self_approved'],
          },
        },
      ]);
    });
  });

  describe('save', () => {
    const save = (service: PricingService, quoteId = 'quote-1') =>
      service.saveQuote(
        'staff-2',
        'XPR-00001',
        {
          quoteId,
          revision: 2,
          items: [{ description: 'Pipe', quantity: 1, unitPrice: 1000 }],
        },
        undefined,
        URL,
      );
    const editor = actor('staff', {
      userId: 'staff-2',
      permissions: ['quote.manage'],
    });

    it('audits the cleared approval request when a held draft is edited', async () => {
      const row = draft({ approvalRequestedAt: NOW });
      const tx = quoteTx(row);
      tx.quote.update.mockResolvedValue({ ...row, revision: 3 });
      const { service, effects } = harness({ actor: editor, tx });
      await save(service);
      expect(updateData(tx.quote.update)).toMatchObject({
        approvalRequestedAt: null,
        approvalRequestedBy: null,
        lastEditedBy: 'staff-2',
      });
      expect(effects.audit.map(({ action }) => action)).toEqual([
        'Quote approval request cleared after edit',
        'Quote draft saved',
      ]);
    });

    it('writes only the save audit for a draft that was not held', async () => {
      const row = draft();
      const tx = quoteTx(row);
      tx.quote.update.mockResolvedValue({ ...row, revision: 3 });
      const { service, effects } = harness({ actor: editor, tx });
      await save(service);
      expect(effects.audit.map(({ action }) => action)).toEqual([
        'Quote draft saved',
      ]);
    });
  });
});

describe('quote.setPayout (B-42)', () => {
  const pricing = actor('staff', {
    userId: 'staff-2',
    permissions: ['quote.manage', 'view.pricing'],
  });
  const setPayout = (service: PricingService, amount = 300_000) =>
    service.setPayout(
      'staff-2',
      'XPR-00001',
      'quote-1',
      amount,
      undefined,
      `${URL}/payout`,
    );
  const accepted = {
    ...sentV1,
    status: 'accepted',
    payoutAmount: 250_000n,
    payoutAssignmentId: 'assign-old',
  };

  it('stores the current assignment and audits before and after', async () => {
    const { service, tx, effects } = harness({
      actor: pricing,
      tx: {
        quote: {
          findFirst: jest.fn().mockResolvedValue(accepted),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });
    await setPayout(service);
    expect(tx.quote.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'quote-1',
        requestId: 'request-1',
        status: { in: ['sent', 'accepted'] },
      },
    });
    expect(updateData(tx.quote.update)).toEqual({
      payoutAmount: 300_000n,
      payoutAssignmentId: 'assign-1',
    });
    expect(effects.audit[0]).toEqual({
      action: 'Provider payout amount changed',
      data: {
        resourceType: 'quote',
        resourceId: 'quote-1',
        changes: {
          before: { payoutAmount: 250_000, payoutAssignmentId: 'assign-old' },
          after: { payoutAmount: 300_000, payoutAssignmentId: 'assign-1' },
        },
      },
    });
  });

  it('records a null before value for a first payout', async () => {
    const { service, effects } = harness({
      actor: pricing,
      tx: {
        quote: {
          findFirst: jest.fn().mockResolvedValue({
            ...sentV1,
            payoutAmount: null,
            payoutAssignmentId: null,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });
    await setPayout(service);
    expect(effects.audit[0].data).toMatchObject({
      changes: {
        before: { payoutAmount: null, payoutAssignmentId: null },
      },
    });
  });

  it('refuses a quote that is not sent or accepted', async () => {
    const { service, tx } = harness({
      actor: pricing,
      tx: {
        quote: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      },
    });
    await expect(setPayout(service)).rejects.toThrow(
      'This quote version no longer exists.',
    );
    expect(tx.quote.update).not.toHaveBeenCalled();
  });

  it('refuses without a current accepted assignment', async () => {
    const { service, tx } = harness({
      actor: pricing,
      tx: {
        quote: {
          findFirst: jest.fn().mockResolvedValue(accepted),
          update: jest.fn(),
        },
        assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    });
    await expect(setPayout(service)).rejects.toThrow(
      'Confirm a provider assignment before setting the payout.',
    );
    expect(tx.quote.update).not.toHaveBeenCalled();
  });

  it('refuses an amount above the quote total', async () => {
    const { service } = harness({
      actor: pricing,
      tx: {
        quote: {
          findFirst: jest.fn().mockResolvedValue(accepted),
          update: jest.fn(),
        },
      },
    });
    await expect(setPayout(service, 500_001)).rejects.toThrow(
      'Enter a payout amount above 0 and no higher than the quote total.',
    );
  });
});

describe('GET /requests/:id/quotes (B-01, E-26)', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'quote-1',
    requestId: 'request-1',
    version: 2,
    revision: 5,
    status: 'sent',
    items: [{ description: 'Labour', quantity: 2, unitPrice: 250_000 }],
    total: 500_000n,
    note: 'Scope note',
    pricingOverrideNote: 'No costing',
    lastEditedBy: 'staff-1',
    returnedNote: 'Check rates',
    publishedAt: NOW,
    validUntil: new Date('2026-11-07T10:00:00.000Z'),
    payoutAmount: 300_000n,
    payoutAssignmentId: 'assign-1',
    ...overrides,
  });
  const list = (h: ReturnType<typeof harness>, userId: string) =>
    h.service.listQuotes({ id: userId } as never, 'XPR-00001');

  it('hides drafts and internals from the owner', async () => {
    const h = harness({
      actor: actor('customer', { userId: 'customer-1' }),
      prisma: {
        quote: { findMany: jest.fn().mockResolvedValue([row()]) },
      },
    });
    const views = (await list(h, 'customer-1')) as Array<
      Record<string, unknown>
    >;
    expect(h.prisma.quote.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', status: { not: 'draft' } },
      orderBy: { version: 'desc' },
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: 'quote-1', total: 500_000 });
    for (const key of [
      'revision',
      'payoutAmount',
      'pricingOverrideNote',
      'lastEditedBy',
      'returnedNote',
      'requestId',
    ])
      expect(views[0]).not.toHaveProperty(key);
  });

  it('answers 404 to another customer', async () => {
    const h = harness({ actor: actor('customer', { userId: 'customer-2' }) });
    await expect(list(h, 'customer-2')).rejects.toMatchObject({
      status: 404,
    });
    expect(h.prisma.quote.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 to a provider with no confirmed assignment', async () => {
    const h = harness({
      actor: actor('provider', { userId: 'provider-9' }),
      prisma: {
        assignment: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'a-9', providerUserId: 'provider-9', status: 'offered' },
            ]),
        },
        quote: { findMany: jest.fn() },
      },
    });
    await expect(list(h, 'provider-9')).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.quote.findMany).not.toHaveBeenCalled();
  });

  it('gives the assigned provider scope lines and their own payout only', async () => {
    const h = harness({
      actor: actor('provider', { userId: 'provider-1' }),
      prisma: {
        assignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'assign-1',
              providerUserId: 'provider-1',
              status: 'accepted',
            },
          ]),
        },
        quote: { findMany: jest.fn().mockResolvedValue([row()]) },
      },
    });
    const views = await list(h, 'provider-1');
    expect(h.prisma.quote.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', status: { in: ['sent', 'accepted'] } },
      orderBy: { version: 'desc' },
    });
    expect(views).toEqual([
      {
        id: 'quote-1',
        version: 2,
        status: 'sent',
        scope: [{ description: 'Labour', quantity: 2 }],
        payoutAmount: 300_000,
      },
    ]);
  });

  it('masks amounts for staff without view.pricing', async () => {
    const h = harness({
      actor: actor('staff', {
        userId: 'staff-3',
        permissions: ['quote.manage'],
      }),
      prisma: {
        quote: { findMany: jest.fn().mockResolvedValue([row()]) },
      },
    });
    const [view] = (await list(h, 'staff-3')) as Array<Record<string, unknown>>;
    expect(view).toMatchObject({
      id: 'quote-1',
      revision: 5,
      total: null,
      payoutAmount: null,
      amountsHidden: true,
      items: [{ description: 'Labour', quantity: 2 }],
    });
    for (const key of ['note', 'pricingOverrideNote', 'payoutSuggestion'])
      expect(view).not.toHaveProperty(key);
    expect(h.prisma.contribution.findMany).not.toHaveBeenCalled();
  });

  it('gives pricing staff amounts and a payout suggestion', async () => {
    const h = harness({
      actor: actor('staff', {
        userId: 'staff-3',
        permissions: ['quote.manage', 'view.pricing'],
      }),
      prisma: {
        quote: { findMany: jest.fn().mockResolvedValue([row()]) },
        assignment: {
          findMany: jest.fn(),
          findFirst: jest.fn().mockResolvedValue({ id: 'assign-1' }),
        },
        contribution: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ assignmentId: 'assign-1', total: 320_000n }]),
        },
      },
    });
    const [view] = (await list(h, 'staff-3')) as Array<Record<string, unknown>>;
    expect(view).toMatchObject({
      total: 500_000,
      payoutAmount: 300_000,
      payoutSuggestion: 320_000,
      amountsHidden: false,
    });
  });

  it('refuses staff with no quote permission', async () => {
    const h = harness({
      actor: actor('staff', {
        userId: 'staff-4',
        permissions: ['request.review'],
      }),
    });
    await expect(list(h, 'staff-4')).rejects.toMatchObject({ status: 403 });
  });
});

describe('GET /requests/:id/contributions (B-41)', () => {
  const cost = {
    id: 'cost-1',
    requestId: 'request-1',
    assignmentId: 'assign-1',
    providerId: 'provider-row-1',
    total: 500_000n,
    items: [{ description: 'Labour', quantity: 2, unitPrice: 250_000 }],
    note: 'rates inside',
    createdAt: NOW,
  };
  const listContributions = (h: ReturnType<typeof harness>, userId: string) =>
    h.service.listContributions({ id: userId } as never, 'XPR-00001');

  it('lists every contribution on the request for staff, masked without view.pricing', async () => {
    const h = harness({
      actor: actor('staff', { userId: 'staff-3', permissions: [] }),
      prisma: {
        contribution: { findMany: jest.fn().mockResolvedValue([cost]) },
      },
    });
    const rows = await listContributions(h, 'staff-3');
    expect(h.prisma.contribution.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows).toEqual([
      {
        id: 'cost-1',
        assignmentId: 'assign-1',
        createdAt: NOW,
        providerId: 'provider-row-1',
        total: null,
        items: [{ description: 'Labour', quantity: 2 }],
        amountsHidden: true,
      },
    ]);
  });

  it('shows pricing staff the numbers', async () => {
    const h = harness({
      actor: actor('staff', {
        userId: 'staff-3',
        permissions: ['view.pricing'],
      }),
      prisma: {
        contribution: { findMany: jest.fn().mockResolvedValue([cost]) },
      },
    });
    expect(await listContributions(h, 'staff-3')).toEqual([
      expect.objectContaining({
        total: 500_000,
        note: 'rates inside',
        amountsHidden: false,
      }),
    ]);
  });

  it('gives a provider only their current assignment as an allow-list DTO', async () => {
    const h = harness({
      actor: actor('provider', { userId: 'provider-1' }),
      prisma: {
        assignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'assign-1',
              providerUserId: 'provider-1',
              status: 'accepted',
            },
          ]),
        },
        contribution: { findMany: jest.fn().mockResolvedValue([cost]) },
      },
    });
    const rows = (await listContributions(h, 'provider-1')) as Array<
      Record<string, unknown>
    >;
    expect(h.prisma.contribution.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', assignmentId: 'assign-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows[0]).toEqual({
      id: 'cost-1',
      assignmentId: 'assign-1',
      createdAt: NOW,
      total: 500_000,
      items: [{ description: 'Labour', quantity: 2, unitPrice: 250_000 }],
      note: 'rates inside',
    });
    expect(rows[0]).not.toHaveProperty('providerId');
    expect(rows[0]).not.toHaveProperty('requestId');
  });

  it('answers 404 to a provider with no assignment and 403 to a customer', async () => {
    const stranger = harness({
      actor: actor('provider', { userId: 'provider-9' }),
    });
    await expect(
      listContributions(stranger, 'provider-9'),
    ).rejects.toMatchObject({ status: 404 });
    const customer = harness({
      actor: actor('customer', { userId: 'customer-1' }),
    });
    await expect(
      listContributions(customer, 'customer-1'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
