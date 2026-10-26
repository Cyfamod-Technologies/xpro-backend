import type { ActorContext } from '../../platform/actor/actor.types';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import { systemCommandKit } from '../system-command.testkit';
import { CancellationService } from './cancellation.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const HOUR = 3_600_000;

const customerActor = (userId = 'customer-1') =>
  ({
    userId,
    kind: 'customer',
    displayName: 'Customer',
    platformRoles: ['customer'],
    accountActive: true,
  }) as unknown as ActorContext;

const staffActor = (...permissions: string[]) =>
  ({
    userId: 'staff-1',
    kind: 'staff',
    displayName: 'Ops',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      permissions: new Set(permissions),
      canOwn: false,
      isSuperAdmin: false,
    },
  }) as unknown as ActorContext;

const unpaid = { paid: false, pendingPaymentAt: null, offlineRecorded: false };
const paid = { paid: true, pendingPaymentAt: null, offlineRecorded: false };
const started = [{ status: 'accepted', workStarted: true }];

type Setup = {
  actor: ActorContext;
  snap?: Record<string, unknown>;
  startedAssignments?: string[];
  accepted?: Array<{ id: string; providerUserId: string }>;
  confirmDueAt?: Date | null;
  reportApprovedAt?: Date | null;
  openApprovals?: Array<{ kind: string; itemId: string }>;
  pendingRow?: Record<string, unknown> | null;
};

function setup(options: Setup) {
  const tx = {
    cancellation: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'c-new', ...data }),
        ),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.pendingRow === undefined ? { id: 'c-1' } : options.pendingRow,
        ),
    },
    assignment: {
      findMany: jest.fn(
        ({ where }: { where: { workStarted?: boolean; status?: string } }) =>
          Promise.resolve(
            where.workStarted
              ? (options.startedAssignments ?? []).map((id) => ({ id }))
              : (options.accepted ?? []),
          ),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    serviceRequest: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        confirmDueAt: options.confirmDueAt ?? null,
        reportApprovedAt: options.reportApprovedAt ?? null,
      }),
    },
    issue: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    progressUpdate: {
      findMany: jest.fn().mockResolvedValue([{ id: 'u-1' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    schedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    approvalDeadline: {
      findMany: jest.fn().mockResolvedValue(options.openApprovals ?? []),
    },
  };
  const kit = systemCommandKit({
    tx,
    now: NOW,
    snap: {
      ownerId: 'customer-1',
      status: 'scheduled',
      intake: { state: 'approved' },
      assignments: [],
      payment: unpaid,
      pendingCancellation: false,
      pendingCancellationInfo: null,
      ...options.snap,
    } as never,
  });
  const payments = { openForCancellation: jest.fn().mockResolvedValue([]) };
  const intake = { freeCancel: jest.fn().mockResolvedValue({ etag: 'free' }) };
  const loader = {
    load: jest.fn().mockResolvedValue({ snapshot: kit.ctx.snap }),
  };
  const service = new CancellationService(
    { resolve: jest.fn().mockResolvedValue(options.actor) } as never,
    kit.runner,
    payments as never,
    intake as never,
    loader,
    {} as never,
  );
  return { service, tx, payments, intake, loader, ...kit };
}

const user = (id: string) => ({ id }) as RequestUser;
const containing = (fields: Record<string, unknown>) =>
  expect.objectContaining(fields) as Record<string, unknown>;
type CreateCall = [{ data: Record<string, unknown> }];
const createdData = (mock: jest.Mock) =>
  (mock.mock.calls[0] as CreateCall)[0].data;
const body = { note: 'No longer needed', reasonCode: 'duplicate' };

describe('POST /requests/:id/cancel dispatch (A-16, D-18)', () => {
  it('runs the free cancel for the owner while it is allowed', async () => {
    const { service, intake, tx } = setup({
      actor: customerActor(),
      snap: { status: 'submitted', intake: { state: 'pending' } },
    });

    await service.cancel(
      user('customer-1'),
      'XPR-00042',
      { note: 'Changed my mind' },
      undefined,
      '/url',
    );

    expect(intake.freeCancel).toHaveBeenCalledTimes(1);
    expect(tx.cancellation.create).not.toHaveBeenCalled();
  });

  it('creates a pending cancellation with the default reason once free cancel is gone', async () => {
    const { service, intake, tx, effects } = setup({
      actor: customerActor(),
      snap: { status: 'under_review' },
    });

    await service.cancel(
      user('customer-1'),
      'XPR-00042',
      { note: '  Changed my mind  ' },
      undefined,
      '/url',
    );

    expect(intake.freeCancel).not.toHaveBeenCalled();
    expect(createdData(tx.cancellation.create)).toMatchObject({
      requestedBy: 'customer',
      requestedById: 'customer-1',
      reasonCode: 'customer_changed_mind',
      note: 'Changed my mind',
      stage: 'under_review',
      paid: false,
      workStarted: false,
    });
    expect(effects.timerStarts).toEqual([
      {
        kind: 'T19.followup',
        dueAt: new Date(NOW.getTime() + 48 * HOUR),
        refId: 'c-new',
        payload: undefined,
      },
    ]);
    expect(effects.notify[0].event).toBe('cancellation.requested');
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    // 02 §6.11: the cancellation item starts at the request, not at the T19 follow-up.
    expect(effects.approvalOpens).toEqual([
      { kind: 'cancellation', itemId: 'c-new' },
    ]);
  });

  it('keeps the reason code the customer sent', async () => {
    const { service, tx } = setup({
      actor: customerActor(),
      snap: { status: 'quoted' },
    });

    await service.cancel(
      user('customer-1'),
      'XPR-00042',
      { note: 'Found someone else', reasonCode: 'other' },
      undefined,
      '/url',
    );

    expect(createdData(tx.cancellation.create).reasonCode).toBe('other');
  });

  it('refuses a second pending request with the spec message', async () => {
    const { service } = setup({
      actor: customerActor(),
      snap: {
        status: 'quoted',
        pendingCancellation: true,
        pendingCancellationInfo: { id: 'c-1', status: 'pending' },
      },
    });

    await expect(
      service.cancel(user('customer-1'), 'XPR-00042', body, undefined, '/url'),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Your cancellation request is already awaiting XPro.',
    });
  });

  it('cancels directly for staff on an unpaid, unstarted request', async () => {
    const { service, tx, payments, effects } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'matched' },
    });

    await service.cancel(user('staff-1'), 'XPR-00042', body, undefined, '/url');

    expect(createdData(tx.cancellation.create)).toMatchObject({
      requestedBy: 'staff',
      requestedById: 'staff-1',
      reasonCode: 'duplicate',
      note: 'No longer needed',
      stage: 'matched',
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelled', cancellationId: 'c-new' },
    });
    expect(payments.openForCancellation).not.toHaveBeenCalled();
    expect(effects.notify.map(({ event }) => event)).toEqual([
      'cancellation.staff_cancelled',
    ]);
    expect(effects.audit.map(({ action }) => action)).toEqual([
      'Request cancelled',
    ]);
  });

  it('needs a reason code from staff', async () => {
    const { service, tx } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'matched' },
    });

    await expect(
      service.cancel(
        user('staff-1'),
        'XPR-00042',
        { note: 'No longer needed' },
        undefined,
        '/url',
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Choose a reason for cancelling this request.',
    });
    expect(tx.cancellation.create).not.toHaveBeenCalled();
  });

  it('refuses staff without request.cancel.active on a paid request, and cancels with it', async () => {
    const paidSnap = { status: 'scheduled', payment: paid };
    const denied = setup({
      actor: staffActor('request.cancel'),
      snap: paidSnap,
    });
    await expect(
      denied.service.cancel(
        user('staff-1'),
        'XPR-00042',
        body,
        undefined,
        '/url',
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Your staff role does not allow this action.',
    });
    expect(denied.tx.cancellation.create).not.toHaveBeenCalled();

    const allowed = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap: paidSnap,
    });
    await allowed.service.cancel(
      user('staff-1'),
      'XPR-00042',
      body,
      undefined,
      '/url',
    );
    expect(allowed.tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelling', cancellationId: 'c-new' },
    });
  });

  it('refuses staff cancel for work started without request.cancel.active', async () => {
    const { service } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'in_progress', assignments: started },
    });

    await expect(
      service.cancel(user('staff-1'), 'XPR-00042', body, undefined, '/url'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers a missing request with the opaque 404', async () => {
    const { service, loader } = setup({ actor: customerActor() });
    loader.load.mockResolvedValue(null);

    await expect(
      service.cancel(user('customer-1'), 'XPR-00042', body, undefined, '/url'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers a customer who does not own the request with 404 from the runner', async () => {
    const row = {
      id: 'request-1',
      ownerId: 'customer-1',
      version: 1,
      status: 'quoted',
      staffOwnerId: null,
      ownershipVersion: 1,
    };
    const snapshot = {
      ownerId: 'customer-1',
      accessibleProviderUserIds: [],
      status: 'quoted',
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $queryRaw: jest.fn() }),
      ),
    };
    const runner = new RequestCommandRunner(
      prisma as never,
      { load: jest.fn().mockResolvedValue({ row, snapshot }) },
      { snapshot: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const service = new CancellationService(
      {
        resolve: jest.fn().mockResolvedValue(customerActor('stranger')),
      } as never,
      runner,
      {} as never,
      { freeCancel: jest.fn() } as never,
      { load: jest.fn().mockResolvedValue({ row, snapshot }) },
      {} as never,
    );

    await expect(
      service.cancel(user('stranger'), 'XPR-00042', body, undefined, '/url'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('cancellation.decide (D-17, D-20)', () => {
  const pendingInfo = (overrides: Record<string, unknown> = {}) => ({
    pendingCancellation: true,
    pendingCancellationInfo: {
      id: 'c-1',
      status: 'pending',
      requestedBy: 'customer',
      paid: false,
      workStarted: false,
      ...overrides,
    },
  });
  const decide = (
    service: CancellationService,
    dto: { approve: boolean; note?: string },
  ) => service.decide('staff-1', 'XPR-00042', dto, undefined, '/url');

  it('writes the recomputed paid and workStarted back to the cancellation', async () => {
    const { service, tx } = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap: {
        status: 'in_progress',
        payment: paid,
        assignments: started,
        // The row is stale: the snapshot loader recomputes it, so the guard sees the live tier.
        ...pendingInfo({ paid: true, workStarted: true }),
      },
      startedAssignments: ['a-1'],
    });

    await decide(service, { approve: false, note: 'Work is under way.' });

    expect(tx.cancellation.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'c-1' },
      data: { paid: true, workStarted: true },
    });
  });

  it('runs under auto-claim, which the runner limits to a rejection (02 §6.5)', async () => {
    const { service, runner } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'quoted', ...pendingInfo() },
    });
    const run = jest.spyOn(runner, 'run');

    await decide(service, { approve: false, note: 'Work is under way.' });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'cancellation.decide',
        autoClaim: true,
        input: { approve: false, note: 'Work is under way.' },
      }),
      expect.any(Function),
    );
  });

  it('sends a declined quote back to Pricing when its cancellation is rejected (Q-def-16)', async () => {
    const { service, tx, effects } = setup({
      actor: staffActor('request.cancel'),
      snap: {
        status: 'matched',
        latestQuote: { status: 'declined', version: 2 },
        ...pendingInfo(),
      },
    });
    Object.assign(tx, {
      quote: { findFirst: jest.fn().mockResolvedValue({ id: 'quote-2' }) },
    });

    await decide(service, { approve: false, note: 'Offer a lower price.' });

    expect(effects.approvalCloses).toEqual([
      { kind: 'cancellation', itemId: 'c-1', reason: 'rejected' },
    ]);
    expect(effects.approvalOpens).toEqual([
      { kind: 'quote_followup', itemId: 'quote-2' },
    ]);
  });

  it('needs request.cancel.active when the live state is paid or started', async () => {
    const { service, tx } = setup({
      actor: staffActor('request.cancel'),
      snap: {
        status: 'scheduled',
        payment: paid,
        ...pendingInfo({ paid: true }),
      },
    });

    await expect(decide(service, { approve: true })).rejects.toMatchObject({
      status: 403,
    });
    expect(tx.cancellation.update).not.toHaveBeenCalled();
  });

  it('approving an unpaid job completes the cancellation and cancels the request', async () => {
    const { service, tx, payments, effects } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'quoted', ...pendingInfo() },
    });

    await decide(service, { approve: true, note: ' Agreed ' });

    expect(tx.cancellation.update).toHaveBeenLastCalledWith({
      where: { id: 'c-1' },
      data: containing({
        status: 'completed',
        decidedBy: 'staff-1',
        decisionNote: 'Agreed',
        paid: false,
        workStarted: false,
        refundDue: false,
        compensationCandidateIds: [],
      }),
    });
    expect(tx.serviceRequest.update).toHaveBeenLastCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelled', cancellationId: 'c-1' },
    });
    expect(payments.openForCancellation).not.toHaveBeenCalled();
    expect(effects.notify.map(({ event }) => event)).toContain(
      'cancellation.approved',
    );
  });

  it('approving a paid job moves to cancelling, opens the refunds and keeps the compensation candidates', async () => {
    const { service, tx, payments } = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap: {
        status: 'in_progress',
        payment: paid,
        assignments: started,
        ...pendingInfo(),
      },
      startedAssignments: ['a-1', 'a-0'],
    });

    await decide(service, { approve: true });

    expect(tx.cancellation.update).toHaveBeenLastCalledWith({
      where: { id: 'c-1' },
      data: containing({
        status: 'approved',
        paid: true,
        workStarted: true,
        refundDue: true,
        compensationCandidateIds: ['a-1', 'a-0'],
      }),
    });
    expect(tx.serviceRequest.update).toHaveBeenLastCalledWith({
      where: { id: 'request-1' },
      data: { status: 'cancelling', cancellationId: 'c-1' },
    });
    expect(payments.openForCancellation).toHaveBeenCalledWith(
      expect.anything(),
      {
        cancellationId: 'c-1',
        requestedBy: 'staff-1',
        workStarted: true,
      },
    );
  });

  it('answers a stale decision after a withdrawal with the not-awaiting message', async () => {
    const { service } = setup({
      actor: staffActor('request.cancel'),
      snap: { status: 'quoted', ...pendingInfo() },
      pendingRow: null,
    });

    await expect(decide(service, { approve: true })).rejects.toMatchObject({
      status: 409,
      message: 'This cancellation request is no longer awaiting a decision.',
    });
  });

  it('rejects a pending cancellation in acknowledged (follow-up) and refuses to approve it', async () => {
    const snap = {
      status: 'acknowledged',
      payment: paid,
      assignments: started,
      ...pendingInfo({ paid: true, workStarted: true }),
    };
    const ok = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap,
    });
    await decide(ok.service, {
      approve: false,
      note: 'The customer confirmed the work.',
    });
    expect(ok.tx.cancellation.update).toHaveBeenLastCalledWith({
      where: { id: 'c-1' },
      data: containing({
        status: 'rejected',
        decisionNote: 'The customer confirmed the work.',
      }),
    });
    expect(ok.tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(ok.effects.timerStarts).toEqual([]);

    const refused = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap,
    });
    await expect(
      decide(refused.service, { approve: true }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This request can no longer be cancelled.',
    });
  });
});

describe('approval cleanup (D-17)', () => {
  const run = async (
    overrides: Partial<Setup> = {},
    actor = staffActor('request.cancel'),
  ) => {
    const harness = setup({
      actor,
      snap: { status: 'in_progress', hold: { kind: 'staff' } },
      accepted: [{ id: 'a-1', providerUserId: 'provider-1' }],
      startedAssignments: ['a-1'],
      openApprovals: [
        { kind: 'cancellation', itemId: 'c-1' },
        { kind: 'progress', itemId: 'request-1' },
        { kind: 'refund', itemId: 'r-1' },
        { kind: 'offline_payment', itemId: 'p-1' },
      ],
      ...overrides,
    });
    await harness.service.staffCancel(
      'staff-1',
      'XPR-00042',
      body,
      undefined,
      '/url',
    );
    return harness;
  };

  it('ends the accepted assignment with request_cancelled and tells the provider', async () => {
    const { tx, effects } = await run();

    expect(tx.assignment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a-1'] }, status: 'accepted' },
      data: containing({
        status: 'withdrawn',
        endReason: 'request_cancelled',
        endedBy: 'staff-1',
      }),
    });
    expect(tx.assignment.updateMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['offered', 'pending_approval'] },
      },
      data: containing({ endReason: 'request_cancelled' }),
    });
    // workStarted is read, never cleared.
    for (const [call] of tx.assignment.updateMany.mock.calls as CreateCall[])
      expect(call.data).not.toHaveProperty('workStarted');
    expect(effects.notify).toContainEqual({
      event: 'cancellation.completed_provider',
      params: {
        requestCode: 'XPR-00042',
        assignmentId: 'a-1',
        providerUserId: 'provider-1',
      },
    });
  });

  it('clears the hold fields', async () => {
    const { tx } = await run();

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        holdKind: null,
        holdBy: null,
        holdReason: null,
        holdAt: null,
        holdPreviousStatus: null,
      },
    });
  });

  it('resolves open, rework and disputed issues as no_rework with a cancelled note', async () => {
    const { tx } = await run();

    expect(tx.issue.updateMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['open', 'rework', 'disputed'] },
      },
      data: {
        status: 'resolved',
        resolvedBy: 'staff-1',
        resolvedAt: NOW,
        resolvedWith: 'no_rework',
        resolution: 'Closed because the request was cancelled.',
      },
    });
  });

  it('auto-rejects every pending progress update on the request', async () => {
    const { tx, effects } = await run();

    expect(tx.progressUpdate.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', state: 'pending' },
      select: { id: true, kind: true },
    });
    expect(tx.progressUpdate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u-1'] }, state: 'pending' },
      data: {
        state: 'rejected',
        systemReason: 'assignment_ended',
        reviewedAt: NOW,
      },
    });
    expect(effects.approvalCloses).toContainEqual({
      kind: 'progress',
      itemId: 'u-1',
      reason: 'assignment_ended',
    });
  });

  it('cancels the open schedules and stops every request timer', async () => {
    const { tx, effects } = await run();

    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['proposed', 'confirmed', 'changes_requested'] },
      },
      data: { status: 'cancelled' },
    });
    const stopAll = effects.timerStops.find(
      ({ kind }) => Array.isArray(kind) && kind.includes('T17.autoConfirm'),
    );
    expect(stopAll?.kind).toEqual(
      expect.arrayContaining(['T9.lapse', 'T19.followup', 'dispatch.cascade']),
    );
  });

  it('closes the staff approval items with the reason but leaves the money items open', async () => {
    const { effects } = await run();

    expect(effects.approvalCloses).toEqual([
      { kind: 'progress', itemId: 'u-1', reason: 'assignment_ended' },
      { kind: 'cancellation', itemId: 'c-1', reason: 'request_cancelled' },
      { kind: 'progress', itemId: 'request-1', reason: 'request_cancelled' },
    ]);
  });

  it('runs the same cleanup when a pending cancellation is approved', async () => {
    const harness = setup({
      actor: staffActor('request.cancel', 'request.cancel.active'),
      snap: {
        status: 'in_progress',
        payment: paid,
        assignments: started,
        pendingCancellation: true,
        pendingCancellationInfo: {
          id: 'c-1',
          status: 'pending',
          requestedBy: 'customer',
          paid: true,
          workStarted: true,
        },
      },
      accepted: [{ id: 'a-1', providerUserId: 'provider-1' }],
      startedAssignments: ['a-1'],
      openApprovals: [{ kind: 'cancellation', itemId: 'c-1' }],
    });

    await harness.service.decide(
      'staff-1',
      'XPR-00042',
      { approve: true },
      undefined,
      '/url',
    );

    expect(harness.tx.issue.updateMany).toHaveBeenCalled();
    expect(harness.tx.schedule.updateMany).toHaveBeenCalled();
    expect(harness.tx.progressUpdate.updateMany).toHaveBeenCalled();
    expect(harness.effects.approvalCloses).toEqual([
      { kind: 'progress', itemId: 'u-1', reason: 'assignment_ended' },
      { kind: 'cancellation', itemId: 'c-1', reason: 'request_cancelled' },
    ]);
  });
});

describe('T17 restart after a rejected or withdrawn cancellation (FX-3.10 follow-up)', () => {
  const pending = {
    status: 'completion_pending',
    pendingCancellation: true,
    pendingCancellationInfo: {
      id: 'c-1',
      status: 'pending',
      requestedBy: 'customer',
      paid: true,
      workStarted: true,
    },
    payment: paid,
    assignments: started,
  };
  const approvedAt = new Date(NOW.getTime() - 30 * HOUR);

  const reject = (harness: ReturnType<typeof setup>) =>
    harness.service.decide(
      'staff-1',
      'XPR-00042',
      { approve: false, note: 'Work is done.' },
      undefined,
      '/url',
    );
  const withdraw = (harness: ReturnType<typeof setup>) =>
    harness.service.withdraw(
      user('customer-1'),
      'XPR-00042',
      {},
      undefined,
      '/url',
    );
  const rejecter = () => staffActor('request.cancel', 'request.cancel.active');

  it.each([
    ['rejected', reject, rejecter],
    ['withdrawn', withdraw, () => customerActor()],
  ])(
    'restarts T17 from the original due time when the cancellation is %s',
    async (_name, act, actor) => {
      const confirmDueAt = new Date(approvedAt.getTime() + 72 * HOUR);
      const harness = setup({
        actor: actor(),
        snap: pending,
        confirmDueAt,
        reportApprovedAt: approvedAt,
        pendingRow: { id: 'c-1' },
      });

      await act(harness);

      expect(harness.effects.timerStarts).toEqual([
        {
          kind: 'T17.reminder48h',
          dueAt: new Date(approvedAt.getTime() + 48 * HOUR),
          refId: undefined,
          payload: undefined,
        },
        {
          kind: 'T17.autoConfirm',
          dueAt: confirmDueAt,
          refId: undefined,
          payload: undefined,
        },
      ]);
      expect(harness.effects.approvalCloses).toContainEqual(
        containing({ kind: 'cancellation', itemId: 'c-1' }),
      );
    },
  );

  it('gives the customer one more hour when the original due time has passed', async () => {
    const harness = setup({
      actor: rejecter(),
      snap: pending,
      confirmDueAt: new Date(NOW.getTime() - 5 * HOUR),
      reportApprovedAt: new Date(NOW.getTime() - 77 * HOUR),
    });

    await reject(harness);

    expect(harness.effects.timerStarts).toEqual([
      {
        kind: 'T17.autoConfirm',
        dueAt: new Date(NOW.getTime() + HOUR),
        refId: undefined,
        payload: undefined,
      },
    ]);
  });

  it('starts nothing for a request that is not awaiting the customer', async () => {
    const harness = setup({
      actor: rejecter(),
      snap: { ...pending, status: 'in_progress' },
      confirmDueAt: new Date(NOW.getTime() + HOUR),
      reportApprovedAt: approvedAt,
    });

    await reject(harness);

    expect(harness.effects.timerStarts).toEqual([]);
  });
});
