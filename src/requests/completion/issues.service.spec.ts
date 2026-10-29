import type { ActorContext } from '../../platform/actor/actor.types';
import { systemCommandKit } from '../system-command.testkit';
import { IssuesService } from './issues.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');

const staffActor = (isSuperAdmin = false) =>
  ({
    userId: 'staff-1',
    kind: 'staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      permissions: new Set(['issue.resolve']),
      isSuperAdmin,
      canOwn: false,
    },
  }) as unknown as ActorContext;

const customerActor = {
  userId: 'customer-1',
  kind: 'customer',
  platformRoles: ['customer'],
  accountActive: true,
} as unknown as ActorContext;

function setup(options: {
  actor: ActorContext;
  snap: Record<string, unknown>;
  issue?: Record<string, unknown> | null;
  otherOpen?: number;
  otherDisputed?: number;
}) {
  const tx = {
    serviceRequest: {
      update: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ issueCycles: 0 }),
      findUnique: jest.fn().mockResolvedValue({ title: 'Roof repair' }),
    },
    issue: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.issue === undefined ? { id: 'i1' } : options.issue,
        ),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'i-new' }),
      count: jest.fn(
        ({ where }: { where: { status: string | { in: string[] } } }) =>
          Promise.resolve(
            where.status === 'disputed'
              ? (options.otherDisputed ?? 0)
              : (options.otherOpen ?? 0),
          ),
      ),
    },
    requestEscalation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
    },
  };
  const kit = systemCommandKit({
    tx,
    now: NOW,
    settings: { 'completion.windowHours': 72 },
    snap: { ownerId: 'customer-1', ...options.snap },
  });
  const finance = { holdForIssue: jest.fn().mockResolvedValue({}) };
  const escalations = { resolveForDispute: jest.fn().mockResolvedValue(1) };
  const approvals = { open: jest.fn() };
  const service = new IssuesService(
    { resolve: jest.fn().mockResolvedValue(options.actor) } as never,
    kit.runner,
    { attach: jest.fn().mockResolvedValue([]) } as never,
    finance as never,
    escalations as never,
  );
  return { service, tx, finance, escalations, approvals, ...kit };
}

const resolve = (
  service: IssuesService,
  dto: Parameters<IssuesService['resolve']>[3],
) => service.resolve('staff-1', 'XPR-00042', 'i1', dto, undefined, '/url');

describe('IssuesService.escalate (D-27)', () => {
  const disputed = { status: 'blocked', openIssues: [{ status: 'open' }] };

  it.each([
    ['omitted', undefined],
    ['blank', '   '],
    ['too short', 'abc'],
  ])(
    'refuses a note that is %s with the 02 §6.10 message',
    async (_n, note) => {
      const { service, tx } = setup({ actor: staffActor(), snap: disputed });

      await expect(
        service.escalate(
          'staff-1',
          'XPR-00042',
          'i1',
          { note },
          undefined,
          '/u',
        ),
      ).rejects.toMatchObject({
        status: 422,
        message: 'Add a note explaining the escalation.',
      });
      expect(tx.issue.update).not.toHaveBeenCalled();
    },
  );

  it('marks the issue disputed and records the trimmed note', async () => {
    const { service, tx, effects } = setup({
      actor: staffActor(),
      snap: disputed,
    });

    await service.escalate(
      'staff-1',
      'XPR-00042',
      'i1',
      { note: '  Customer disputes the fix.  ' },
      undefined,
      '/u',
    );

    expect(tx.issue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'disputed' },
    });
    expect(tx.requestEscalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        target: 'super_admin',
        note: 'Customer disputes the fix.',
      }) as unknown,
    });
    expect(effects.audit.map(({ action }) => action)).toEqual([
      'request.escalated',
      'Issue escalated',
    ]);
    expect(effects.audit[1]).toMatchObject({
      data: { note: 'Customer disputes the fix.' },
    });
    expect(effects.notify).toContainEqual({
      event: 'escalation.raised_super_admin',
      params: {
        requestCode: 'XPR-00042',
        title: 'Roof repair',
        note: 'Customer disputes the fix.',
      },
    });
    expect(effects.approvalOpens).toContainEqual({
      kind: 'escalation',
      itemId: 'esc-1',
    });
    expect(effects.approvalCloses).toContainEqual({
      kind: 'completion_issue',
      itemId: 'i1',
      reason: 'escalated',
    });
  });
});

describe('IssuesService.resolve (D-28, D-29)', () => {
  const disputed = {
    status: 'blocked',
    openIssues: [{ status: 'disputed' }],
  };

  it('leaves the resolution fields null when a dispute decision requires rework, and resolves the escalation', async () => {
    const { service, tx, escalations, ctx, effects } = setup({
      actor: staffActor(true),
      snap: disputed,
    });

    await resolve(service, {
      outcome: 'dispute_decision',
      requireRework: true,
      note: 'Redo the grouting.',
    });

    const data = (
      tx.issue.update.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).toEqual({
      status: 'rework',
      acceptedBy: 'staff-1',
      acceptedAt: NOW,
    });
    expect(data).not.toHaveProperty('resolvedBy');
    expect(data).not.toHaveProperty('resolvedAt');
    expect(data).not.toHaveProperty('resolvedWith');
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'in_progress' },
    });
    expect(escalations.resolveForDispute).toHaveBeenCalledWith(
      ctx,
      'staff-1',
      'Redo the grouting.',
    );
    expect(effects.notify.map(({ event }) => event)).toEqual([
      'issue.rework_accepted',
    ]);
  });

  it('resolves the issue and the escalation on a final dispute decision', async () => {
    const { service, tx, escalations, effects } = setup({
      actor: staffActor(true),
      snap: disputed,
    });

    await resolve(service, {
      outcome: 'dispute_decision',
      note: 'No rework needed.',
    });

    expect(effects.approvalCloses).toContainEqual({
      kind: 'completion_issue',
      itemId: 'i1',
      reason: 'resolved',
    });

    expect(tx.issue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: expect.objectContaining({
        status: 'resolved',
        resolvedBy: 'staff-1',
        resolvedAt: NOW,
        resolvedWith: 'dispute_decision',
        resolution: 'No rework needed.',
      }) as unknown,
    });
    expect(escalations.resolveForDispute).toHaveBeenCalledTimes(1);
  });

  it('keeps the escalation open while another issue is still disputed', async () => {
    const { service, escalations } = setup({
      actor: staffActor(true),
      snap: disputed,
      otherDisputed: 1,
      otherOpen: 1,
    });

    await resolve(service, { outcome: 'dispute_decision', note: 'Done.' });

    expect(escalations.resolveForDispute).not.toHaveBeenCalled();
  });

  it('refuses a dispute decision from staff who are not super admins', async () => {
    const { service, tx, escalations } = setup({
      actor: staffActor(false),
      snap: disputed,
    });

    await expect(
      resolve(service, { outcome: 'dispute_decision', note: 'Done.' }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'A super admin must decide this dispute.',
    });
    expect(tx.issue.update).not.toHaveBeenCalled();
    expect(escalations.resolveForDispute).not.toHaveBeenCalled();
  });

  it('tells the customer to reconfirm and the provider the issue is resolved when no issue remains', async () => {
    const { service, tx, effects } = setup({
      actor: staffActor(),
      snap: { status: 'in_progress', openIssues: [{ status: 'rework' }] },
    });

    await resolve(service, { outcome: 'no_rework', note: 'Work is fine.' });

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        status: 'completion_pending',
        confirmDueAt: new Date(NOW.getTime() + 72 * 3_600_000),
      }) as unknown,
    });
    expect(effects.notify).toEqual([
      { event: 'issue.resolved', params: { requestCode: 'XPR-00042' } },
      {
        event: 'progress.completion_approved',
        params: { requestCode: 'XPR-00042' },
      },
    ]);
    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T17.reminder24h',
      'T17.reminder48h',
      'T17.autoConfirm',
    ]);
  });

  it('only tells the provider when another issue is still open', async () => {
    const { service, tx, effects } = setup({
      actor: staffActor(),
      snap: {
        status: 'in_progress',
        openIssues: [{ status: 'rework' }, { status: 'open' }],
      },
      otherOpen: 1,
    });

    await resolve(service, { outcome: 'no_rework', note: 'Work is fine.' });

    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(effects.notify.map(({ event }) => event)).toEqual([
      'issue.resolved',
    ]);
  });
});

describe('IssuesService.raise (D-28)', () => {
  it('holds the payout through FinanceService.holdForIssue', async () => {
    const { service, finance, ctx } = setup({
      actor: customerActor,
      snap: {
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(NOW.getTime() + 86_400_000),
        openIssues: [],
      },
    });

    await service.raise(
      { id: 'customer-1' } as never,
      'XPR-00042',
      { note: 'The leak is back.' },
      undefined,
      '/url',
    );

    expect(finance.holdForIssue).toHaveBeenCalledWith(
      ctx,
      'request-1',
      'i-new',
    );
  });

  it('opens the completion_issue item and closes ready_to_close (02 §6.11)', async () => {
    const { service, effects } = setup({
      actor: customerActor,
      snap: {
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(NOW.getTime() + 86_400_000),
        openIssues: [],
      },
    });

    await service.raise(
      { id: 'customer-1' } as never,
      'XPR-00042',
      { note: 'The leak is back.' },
      undefined,
      '/url',
    );

    expect(effects.approvalOpens).toEqual([
      { kind: 'completion_issue', itemId: 'i-new' },
    ]);
    expect(effects.approvalCloses).toEqual([
      { kind: 'ready_to_close', itemId: 'request-1', reason: 'issue_raised' },
    ]);
  });

  it('waits on the super admin escalation instead once the cycle limit is passed', async () => {
    const { service, tx, effects } = setup({
      actor: customerActor,
      snap: {
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(NOW.getTime() + 86_400_000),
        openIssues: [],
      },
    });
    tx.serviceRequest.findUniqueOrThrow.mockResolvedValue({ issueCycles: 2 });

    await service.raise(
      { id: 'customer-1' } as never,
      'XPR-00042',
      { note: 'Still leaking.' },
      undefined,
      '/url',
    );

    expect(effects.approvalOpens).toEqual([
      { kind: 'escalation', itemId: 'esc-1' },
    ]);
    expect(tx.requestEscalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        target: 'super_admin',
        source: 'system',
      }) as unknown,
    });
  });

  it('refuses a closed defects window through the guard', async () => {
    const { service, finance } = setup({
      actor: customerActor,
      snap: {
        status: 'acknowledged',
        defectsWindowEndsAt: new Date(NOW.getTime() - 1000),
        openIssues: [],
      },
    });
    const raise = (note: string) =>
      service.raise(
        { id: 'customer-1' } as never,
        'XPR-00042',
        { note },
        undefined,
        '/url',
      );

    await expect(raise('Leak')).rejects.toMatchObject({
      status: 409,
      message: 'The defects window has ended.',
    });
    expect(finance.holdForIssue).not.toHaveBeenCalled();
  });
});
