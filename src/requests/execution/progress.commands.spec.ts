import type { ActorContext } from '../../platform/actor/actor.types';
import { PROGRESS_UPDATE_ENTITY } from '../../uploads/entity-types';
import type { RequestSnapshot } from '../domain/snapshot';
import { systemCommandKit } from '../system-command.testkit';
import { ProgressService } from './progress.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const START = new Date('2026-10-26T12:00:00.000Z');
const STALE =
  'This update no longer fits the current job status. Reject it instead.';

const staffActor = {
  userId: 'staff-1',
  kind: 'staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    permissions: new Set(['progress.review']),
    canOwn: true,
    isSuperAdmin: false,
  },
} as unknown as ActorContext;
const providerActor = {
  userId: 'provider-user-1',
  kind: 'provider',
  platformRoles: ['provider'],
  accountActive: true,
} as unknown as ActorContext;

type UpdateRow = {
  id: string;
  kind: string;
  target: string;
  state: string;
  assignmentId: string;
  issueId: string | null;
};
const pendingRow = (overrides: Partial<UpdateRow> = {}): UpdateRow => ({
  id: 'u1',
  kind: 'progress',
  target: 'in_progress',
  state: 'pending',
  assignmentId: 'a1',
  issueId: null,
  ...overrides,
});

function buildTx(
  options: {
    update?: UpdateRow | null;
    issues?: Array<{ id: string; status: string }>;
    linkedIssue?: { status: string } | null;
    schedule?: { startAt: Date } | null;
    pending?: Array<{ id?: string; kind: string }>;
    approved?: Array<{ id: string }>;
    attachedTo?: string[];
    providerStatus?: string;
    assignment?: Record<string, unknown> | null;
  } = {},
) {
  const attachedTo = options.attachedTo ?? [];
  return {
    approvalDeadline: { findMany: jest.fn().mockResolvedValue([]) },
    progressUpdate: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.update === undefined ? pendingRow() : options.update,
        ),
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { state: string } }) =>
          Promise.resolve(
            where.state === 'approved'
              ? (options.approved ?? [])
              : (options.pending ?? []),
          ),
        ),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'new-update', ...data }),
        ),
    },
    assignment: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.assignment === undefined
            ? { id: 'a1', providerUserId: 'provider-user-1' }
            : options.assignment,
        ),
      update: jest.fn(),
    },
    issue: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.linkedIssue === undefined ? null : options.linkedIssue,
        ),
      findMany: jest.fn().mockResolvedValue(options.issues ?? []),
      update: jest.fn(),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: options.providerStatus ?? 'active' }),
    },
    schedule: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.schedule === undefined
            ? { startAt: START }
            : options.schedule,
        ),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    upload: {
      count: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { entityId: { in: string[] } } }) =>
            Promise.resolve(
              where.entityId.in.filter((id) => attachedTo.includes(id)).length,
            ),
        ),
    },
    serviceRequest: { update: jest.fn() },
  };
}

function setup(
  actor: ActorContext,
  tx: ReturnType<typeof buildTx>,
  snap: Partial<RequestSnapshot> = {},
  settings: Record<string, unknown> = {},
) {
  const kit = systemCommandKit({
    tx,
    now: NOW,
    settings,
    snap: {
      status: 'in_progress',
      ownerId: 'customer-1',
      currentProviderUserId: 'provider-user-1',
      currentAssignment: {
        status: 'accepted',
        attempt: 1,
        expiresAt: NOW,
      },
      pendingUpdates: [{ kind: 'progress', state: 'pending' }],
      ...snap,
    } as never,
  });
  const uploads = {
    attach: jest.fn().mockResolvedValue([]),
  };
  const service = new ProgressService(
    {} as never,
    { resolve: jest.fn().mockResolvedValue(actor) } as never,
    kit.runner,
    uploads as never,
  );
  return { service, uploads, ...kit };
}

const review = (
  service: ProgressService,
  dto: { approve: boolean; note?: string },
) => service.review('staff-1', 'XPR-00042', 'u1', dto, undefined, '/url');

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the command to be refused.');
};

describe('ProgressService.review', () => {
  describe('stale kind (D-03)', () => {
    it.each([
      [
        'a pending start once the job is in progress',
        pendingRow({ kind: 'start' }),
        { status: 'in_progress' },
      ],
      [
        'a pending completion on a request awaiting the customer',
        pendingRow({ kind: 'completion', target: 'completion_pending' }),
        { status: 'completion_pending' },
      ],
      [
        'a pending progress update on a cancelled request',
        pendingRow(),
        { status: 'cancelled' },
      ],
      [
        'a pending blocker once the job is already blocked',
        pendingRow({ kind: 'blocker', target: 'blocked' }),
        { status: 'blocked' },
      ],
    ])('refuses to approve %s', async (_name, update, snap) => {
      const tx = buildTx({ update });
      const { service } = setup(
        staffActor,
        tx,
        snap as Partial<RequestSnapshot>,
      );

      const error = await refusal(review(service, { approve: true }));

      expect(error.message).toBe(
        snap.status === 'cancelled' ? 'This request is no longer open.' : STALE,
      );
      expect(tx.progressUpdate.update).not.toHaveBeenCalled();
      expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    });

    it('refuses a plain progress update once a rework issue exists', async () => {
      const tx = buildTx({
        update: pendingRow(),
        linkedIssue: { status: 'rework' },
      });
      const { service } = setup(staffActor, tx);

      const error = await refusal(review(service, { approve: true }));

      expect(error.message).toBe(STALE);
    });

    it('refuses a rework update whose issue is already resolved', async () => {
      const tx = buildTx({
        update: pendingRow({ kind: 'rework', issueId: 'i1' }),
        linkedIssue: { status: 'resolved' },
      });
      const { service } = setup(staffActor, tx);

      const error = await refusal(review(service, { approve: true }));

      expect(error.message).toBe(STALE);
    });

    it('still lets staff reject a stale update', async () => {
      const tx = buildTx({ update: pendingRow({ kind: 'start' }) });
      const { service, effects } = setup(staffActor, tx);

      await review(service, { approve: false, note: 'No longer needed.' });

      expect(tx.progressUpdate.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({ state: 'rejected' }) as unknown,
      });
      expect(tx.serviceRequest.update).not.toHaveBeenCalled();
      expect(effects.audit[0].action).toBe('Progress update rejected');
    });

    it('refuses any approval while an issue is disputed', async () => {
      const tx = buildTx({
        update: pendingRow({
          kind: 'completion',
          target: 'completion_pending',
        }),
      });
      const { service } = setup(staffActor, tx, {
        status: 'blocked',
        openIssues: [{ status: 'disputed' }],
      });

      const error = await refusal(review(service, { approve: true }));

      expect(error.message).toBe(STALE);
    });
  });

  describe('completion evidence (D-12)', () => {
    const completion = pendingRow({
      kind: 'completion',
      target: 'completion_pending',
    });

    it('counts approved updates of the update’s own assignment', async () => {
      const tx = buildTx({
        update: completion,
        approved: [{ id: 'earlier' }],
        attachedTo: ['earlier'],
      });
      const { service } = setup(staffActor, tx);

      await review(service, { approve: true });

      expect(tx.progressUpdate.findMany).toHaveBeenCalledWith({
        where: {
          requestId: 'request-1',
          assignmentId: 'a1',
          state: 'approved',
        },
        select: { id: true },
      });
      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-1' },
        data: expect.objectContaining({
          status: 'completion_pending',
        }) as unknown,
      });
    });

    it('counts this update’s own attachments', async () => {
      const tx = buildTx({ update: completion, attachedTo: ['u1'] });
      const { service } = setup(staffActor, tx);

      await review(service, { approve: true });

      expect(tx.serviceRequest.update).toHaveBeenCalled();
    });

    it('refuses when neither this update nor an approved one has evidence', async () => {
      const tx = buildTx({
        update: completion,
        approved: [{ id: 'earlier' }],
        attachedTo: [],
      });
      const { service } = setup(staffActor, tx);

      const error = await refusal(review(service, { approve: true }));

      expect(error.message).toBe(
        'Work evidence is required before completion can be approved.',
      );
    });
  });

  it('keeps the spec order: assignment, then fit, then suspension', async () => {
    const gone = buildTx({ assignment: null });
    expect(
      (
        await refusal(
          review(setup(staffActor, gone).service, { approve: true }),
        )
      ).message,
    ).toBe(
      'This update came from a provider who is no longer on the job. Reject it instead.',
    );

    const suspended = buildTx({ providerStatus: 'suspended' });
    expect(
      (
        await refusal(
          review(setup(staffActor, suspended).service, { approve: true }),
        )
      ).message,
    ).toBe(
      'This provider is suspended. Reject the update or replace the provider.',
    );
  });

  it('resolves the linked issue and starts T17 afresh for a rework completion', async () => {
    const tx = buildTx({
      update: pendingRow({
        kind: 'rework_completion',
        target: 'completion_pending',
        issueId: 'i1',
      }),
      linkedIssue: { status: 'rework' },
      attachedTo: ['u1'],
    });
    const { service, effects } = setup(staffActor, tx);

    await review(service, { approve: true });

    expect(tx.issue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: expect.objectContaining({
        status: 'resolved',
        resolvedWith: 'rework',
        evidenceUpdateIds: { push: 'u1' },
      }) as unknown,
    });
    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T17.reminder24h',
      'T17.reminder48h',
      'T17.autoConfirm',
    ]);
    expect(effects.notify).toEqual([
      {
        event: 'progress.completion_approved',
        params: { requestCode: 'XPR-00042' },
      },
    ]);
  });
});

describe('approval effects are shared by review and addOnBehalf (D-13)', () => {
  const noteBody = { note: 'Walked the site with the foreman.' };
  const onBehalf = (service: ProgressService, dto: Record<string, unknown>) =>
    service.addOnBehalf(
      'staff-1',
      'XPR-00042',
      {
        status: 'in_progress',
        reportedVia: 'Phone call',
        attachments: [],
        ...noteBody,
        ...dto,
      } as never,
      undefined,
      '/url',
    );

  const effectsOf = (run: ReturnType<typeof setup>) => ({
    timers: run.effects.timerStarts.map(({ kind }) => kind),
    stops: run.effects.timerStops
      .filter(({ refId }) => refId === undefined)
      .flatMap(({ kind }) => kind),
    notify: run.effects.notify.map(({ event }) => event),
  });

  it.each([
    [
      'start',
      { status: 'in_progress' },
      { status: 'scheduled' as const },
      pendingRow({ kind: 'start' }),
    ],
    [
      'blocker',
      { status: 'blocked' },
      { status: 'in_progress' as const },
      pendingRow({ kind: 'blocker', target: 'blocked' }),
    ],
    [
      'resume',
      { status: 'in_progress' },
      { status: 'blocked' as const },
      pendingRow({ kind: 'resume' }),
    ],
    [
      'completion',
      { status: 'completion_pending', attachments: [{ id: 'f1' }] },
      { status: 'in_progress' as const },
      pendingRow({ kind: 'completion', target: 'completion_pending' }),
    ],
  ])(
    '%s: the same timers and customer notice either way',
    async (_kind, body, snap, update) => {
      const viaReview = setup(
        staffActor,
        buildTx({ update, attachedTo: ['u1'] }),
        snap,
      );
      await review(viaReview.service, { approve: true });

      const viaStaff = setup(
        staffActor,
        buildTx({ schedule: { startAt: START } }),
        { ...snap, pendingUpdates: [] },
      );
      await onBehalf(viaStaff.service, body);

      const reviewed = effectsOf(viaReview);
      const recorded = effectsOf(viaStaff);
      expect(recorded.timers).toEqual(reviewed.timers);
      expect(recorded.stops).toEqual(reviewed.stops);
      expect(recorded.notify).toEqual([
        ...reviewed.notify,
        'progress.on_behalf',
      ]);
    },
  );

  it('sends the customer the Work started notice and the provider the on-behalf notice', async () => {
    const run = setup(staffActor, buildTx(), {
      status: 'scheduled',
      pendingUpdates: [],
    });

    await onBehalf(run.service, {});

    expect(run.effects.notify.map(({ event }) => event)).toEqual([
      'progress.started',
      'progress.on_behalf',
    ]);
  });

  it('resolves the rework issue when staff record the rework completion', async () => {
    const tx = buildTx({
      issues: [{ id: 'i1', status: 'rework' }],
    });
    const run = setup(staffActor, tx, { pendingUpdates: [] });

    await onBehalf(run.service, {
      status: 'completion_pending',
      issueId: 'i1',
      attachments: [{ id: 'f1' }],
    });

    expect(tx.issue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: expect.objectContaining({
        status: 'resolved',
        resolvedBy: 'staff-1',
        resolvedWith: 'rework',
        evidenceUpdateIds: { push: 'new-update' },
      }) as unknown,
    });
    expect(run.effects.notify.map(({ event }) => event)).toContain(
      'progress.completion_approved',
    );
  });

  it('stores who recorded it, the note and the channel', async () => {
    const tx = buildTx();
    const run = setup(staffActor, tx, { pendingUpdates: [] });

    await onBehalf(run.service, { reportedVia: ' Phone call ' });

    expect(tx.progressUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        state: 'approved',
        reviewedBy: 'staff-1',
        onBehalf: {
          staffId: 'staff-1',
          note: 'Walked the site with the foreman.',
          reportedVia: 'Phone call',
        },
      }) as unknown,
    });
  });

  it('skips the early-start and one-pending rows', async () => {
    const tx = buildTx({
      pending: [{ kind: 'progress' }],
      schedule: { startAt: new Date(NOW.getTime() + 30 * 60 * 60_000) },
    });
    const run = setup(staffActor, tx, {
      status: 'scheduled',
      pendingUpdates: [{ kind: 'progress', state: 'pending' }],
    });

    await onBehalf(run.service, {});

    expect(tx.progressUpdate.create).toHaveBeenCalled();
  });

  it('runs the add rules: evidence is needed to record a completion', async () => {
    const run = setup(staffActor, buildTx(), { pendingUpdates: [] });

    const error = await refusal(
      onBehalf(run.service, { status: 'completion_pending' }),
    );

    expect(error.message).toBe(
      'Attach work evidence before reporting completion.',
    );
  });

  it('runs the add rules: a rework issue needs the link', async () => {
    const run = setup(
      staffActor,
      buildTx({ issues: [{ id: 'i1', status: 'rework' }] }),
      { pendingUpdates: [] },
    );

    const error = await refusal(onBehalf(run.service, {}));

    expect(error.message).toBe('Link this update to the issue you are fixing.');
  });

  it('refuses to resume or complete while the issue is open (guard row 7)', async () => {
    const run = setup(staffActor, buildTx(), {
      status: 'blocked',
      pendingUpdates: [],
      openIssues: [{ status: 'open' }],
    });

    const error = await refusal(onBehalf(run.service, {}));

    expect(error.message).toBe(
      'XPro is resolving the issue reported at completion. You can update the job once it is resolved.',
    );
  });
});

describe('ProgressService.add', () => {
  const add = (service: ProgressService, dto: Record<string, unknown> = {}) =>
    service.add(
      'provider-user-1',
      'XPR-00042',
      {
        status: 'in_progress',
        note: 'Second fix under way.',
        attachments: [],
        ...dto,
      } as never,
      undefined,
      '/url',
      'key-1',
    );

  it('attaches the ids of the nested { id } references as progress evidence', async () => {
    const tx = buildTx();
    const run = setup(providerActor, tx, { pendingUpdates: [] });

    await add(run.service, { attachments: [{ id: 'f1' }, { id: 'f2' }] });

    expect(run.uploads.attach).toHaveBeenCalledWith(
      tx,
      ['f1', 'f2'],
      'provider-user-1',
      'progress_evidence',
      PROGRESS_UPDATE_ENTITY,
      'new-update',
    );
  });

  it('refuses a start before startAt minus 2 h and names that time in WAT', async () => {
    const tx = buildTx({
      schedule: { startAt: new Date('2026-10-26T14:00:00.000Z') },
    });
    const run = setup(providerActor, tx, {
      status: 'scheduled',
      pendingUpdates: [],
    });

    const error = await refusal(add(run.service));

    expect(error.message).toBe('You can start this job from 13:00 WAT.');
  });

  it('accepts a completion when an approved update of the assignment has evidence (D-12)', async () => {
    const tx = buildTx({
      approved: [{ id: 'earlier' }],
      attachedTo: ['earlier'],
    });
    const run = setup(providerActor, tx, { pendingUpdates: [] });

    await add(run.service, { status: 'completion_pending' });

    expect(tx.progressUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'completion' }) as unknown,
    });
  });

  it('does not link an issueId that is not in rework', async () => {
    const tx = buildTx();
    const run = setup(providerActor, tx, { pendingUpdates: [] });

    await add(run.service, { issueId: 'i-resolved' });

    expect(tx.progressUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'progress',
        issueId: null,
      }) as unknown,
    });
  });

  it('lets a blocker replace a pending routine update and closes its queue item', async () => {
    const tx = buildTx({ pending: [{ id: 'p1', kind: 'progress' }] });
    const run = setup(providerActor, tx);

    await add(run.service, { status: 'blocked' });

    expect(tx.progressUpdate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1'] }, state: 'pending' },
      data: expect.objectContaining({
        systemReason: 'replaced_by_blocker',
      }) as unknown,
    });
    expect(tx.progressUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'blocker' }) as unknown,
    });
    expect(run.effects.approvalCloses).toContainEqual({
      kind: 'progress',
      itemId: 'p1',
      reason: 'replaced_by_blocker',
    });
  });

  it.each([
    ['in_progress', 'progress'],
    ['blocked', 'blocker'],
    ['completion_pending', 'completion'],
  ] as const)(
    'opens a %s review item for the update and starts no T15/T16 clock (D-14)',
    async (status, item) => {
      const tx = buildTx({
        approved: [{ id: 'earlier' }],
        attachedTo: ['earlier'],
      });
      const run = setup(providerActor, tx, { pendingUpdates: [] });

      await add(run.service, { status });

      expect(run.effects.approvalOpens).toEqual([
        { kind: item, itemId: 'new-update' },
      ]);
      expect(run.effects.timerStarts).toEqual([]);
    },
  );

  it('closes the update item when staff review it', async () => {
    const kit = setup(
      staffActor,
      buildTx({ update: pendingRow({ kind: 'blocker' }) }),
      {},
    );

    await review(kit.service, { approve: false, note: 'Not a blocker.' });

    expect(kit.effects.approvalCloses).toContainEqual({
      kind: 'blocker',
      itemId: 'u1',
      reason: 'rejected',
    });
  });
});

describe('T15 stale and escalation timers (D-35)', () => {
  const run = async (
    update: UpdateRow,
    snap: Partial<RequestSnapshot>,
    tx = buildTx({ update, attachedTo: ['u1'] }),
  ) => {
    const kit = setup(staffActor, tx, snap);
    await review(kit.service, { approve: true });
    return kit.effects;
  };
  const started = (effects: ReturnType<typeof setup>['effects']) =>
    effects.timerStarts.map(({ kind }) => kind);
  const stopped = (effects: ReturnType<typeof setup>['effects']) =>
    effects.timerStops
      .filter(({ refId }) => refId === undefined)
      .flatMap(({ kind }) => kind);

  it('an approved start starts both', async () => {
    const effects = await run(pendingRow({ kind: 'start' }), {
      status: 'scheduled',
    });
    expect(started(effects)).toEqual(['T15.stale', 'T15.escalate']);
  });

  it('an approved progress update restarts both', async () => {
    const effects = await run(pendingRow(), {});
    expect(started(effects)).toEqual(['T15.stale', 'T15.escalate']);
  });

  it('an approved resume starts both and stops T16', async () => {
    const effects = await run(pendingRow({ kind: 'resume' }), {
      status: 'blocked',
    });
    expect(started(effects)).toEqual(['T15.stale', 'T15.escalate']);
    expect(stopped(effects)).toContain('T16.review');
  });

  it('an approved blocker stops both and starts T16', async () => {
    const effects = await run(
      pendingRow({ kind: 'blocker', target: 'blocked' }),
      {},
    );
    expect(stopped(effects)).toEqual(
      expect.arrayContaining(['T15.stale', 'T15.escalate']),
    );
    expect(started(effects)).toEqual(['T16.review']);
  });

  it('an approved completion stops both', async () => {
    const effects = await run(
      pendingRow({ kind: 'completion', target: 'completion_pending' }),
      {},
    );
    expect(stopped(effects)).toEqual(
      expect.arrayContaining(['T15.stale', 'T15.escalate']),
    );
    expect(started(effects)).not.toContain('T15.stale');
  });
});
