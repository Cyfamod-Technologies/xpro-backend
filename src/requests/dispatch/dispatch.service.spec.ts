import { Prisma } from '@prisma/client';
import { AppError } from '../../platform/errors/app-error';
import type { RequestSnapshot } from '../domain/snapshot';
import { systemCommandKit } from '../system-command.testkit';
import { designRequestRow, dispatchProvider } from './dispatch.testkit';
import { DispatchService } from './dispatch.service';

const now = new Date('2026-10-24T12:00:00.000Z');
const hour = 60 * 60 * 1000;
const staffActor = {
  userId: 'staff-1',
  kind: 'staff',
  platformRoles: ['staff'],
  staff: { status: 'active', permissions: new Set(['dispatch.manage']) },
};
const providerActor = {
  userId: 'user-p1',
  kind: 'provider',
  platformRoles: ['provider'],
};

type Mocks = Record<string, unknown>;

function build<T extends Mocks = Mocks>(
  options: {
    tx?: T;
    snap?: Partial<RequestSnapshot>;
    settings?: Record<string, unknown>;
    providers?: ReturnType<typeof dispatchProvider>[];
    actor?: unknown;
    prisma?: Mocks;
  } = {},
) {
  const providers = options.providers ?? [];
  const base = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(designRequestRow),
      update: jest.fn(),
    },
  };
  const tx = { ...base, ...options.tx } as typeof base & T;
  const kit = systemCommandKit({
    now,
    tx,
    snap: { cityName: 'Lagos', ...options.snap },
    settings: options.settings,
  });
  const runner = {
    run: jest.fn(async (_options: unknown, fn: (ctx: unknown) => unknown) => {
      await fn(kit.ctx);
      return { status: 200, body: {}, etag: 'W/"2"' };
    }),
  };
  const loader = {
    list: jest.fn().mockResolvedValue(providers),
    one: jest.fn((id: string): Promise<unknown> =>
      Promise.resolve(providers.find((item) => item.id === id) ?? null),
    ),
  };
  const actors = {
    resolve: jest.fn().mockResolvedValue(options.actor ?? staffActor),
  };
  const service = new DispatchService(
    (options.prisma ?? {}) as never,
    actors as never,
    runner as never,
    loader as never,
  );
  return { service, tx, loader, ...kit };
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected the command to be refused.');
};
const expectRefusal = (
  error: AppError,
  status: number,
  code: string,
  message: string,
) => {
  expect(error.getStatus()).toBe(status);
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
};

describe('DispatchService.offer (04 §6.6 manual offer)', () => {
  const run = (
    eligible: string[],
    patch: { at?: Date; found?: boolean } = {},
  ) =>
    patch.found === false
      ? null
      : {
          id: 'run-1',
          at: patch.at ?? new Date(now.getTime() - 5 * 60_000),
          eligible: eligible.map((providerId, index) => ({
            providerId,
            total: 90 - index,
            factors: { area: 1 },
          })),
        };
  const offerTx = (runRow: unknown) => ({
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(designRequestRow),
      update: jest.fn(),
    },
    dispatchRun: { findFirst: jest.fn().mockResolvedValue(runRow) },
    assignment: {
      create: jest.fn().mockResolvedValue({ id: 'assignment-new' }),
    },
    providerProfile: { update: jest.fn() },
  });
  const settings = { 'assignment.rankingRunMaxAgeMinutes': 15 };
  const offer = (
    service: DispatchService,
    dto: { providerId?: string; overrideNote?: string; note?: string } = {},
  ) =>
    service.offer(
      'staff-1',
      'XPR-00042',
      { providerId: 'p1', rankingRunId: 'run-1', ...dto },
      undefined,
      '/url',
    );

  it.each([
    ['is missing', { found: false }],
    ['is older than 15 minutes', { at: new Date(now.getTime() - 16 * 60_000) }],
  ])('refuses a ranking run that %s', async (_name, patch) => {
    const { service, tx } = build({
      tx: offerTx(run(['p1'], patch)),
      settings,
      providers: [dispatchProvider('p1')],
    });

    expectRefusal(
      await rejection(offer(service)),
      409,
      'STATE_CONFLICT',
      'The ranked list is out of date. Refresh it and choose again.',
    );
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });

  it('offers the top suggestion without a note: attempt null, score from the run, nothing overridden', async () => {
    const tx = offerTx(run(['p1', 'p2']));
    const { service, effects, loader } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1'), dispatchProvider('p2')],
    });

    await offer(service);

    expect(loader.one).toHaveBeenCalledWith('p1', now, 'request-1', tx);
    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'manual',
        attempt: null,
        score: { total: 90, factors: { area: 1 } },
        overriddenRules: [],
        overrideNote: null,
        rankingRunId: 'run-1',
      }) as unknown,
    });
    expect(effects.audit.map(({ action }) => action)).toEqual([
      'Assignment offered',
    ]);
    expect(effects.notify[0]).toMatchObject({
      event: 'assignment.offered',
      params: {
        skill: 'Architectural plan',
        district: 'Ikeja',
        service: 'Design',
      },
    });
  });

  it('does not count a manual offer toward the automatic attempts', async () => {
    const tx = offerTx(run(['p1']));
    const { service } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1')],
    });

    await offer(service);

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'under_review', needsAssignmentReason: null },
    });
  });

  it('needs a note when the provider is not the run’s top suggestion, then audits the override', async () => {
    const tx = offerTx(run(['p1', 'p2']));
    const { service, effects } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1'), dispatchProvider('p2')],
    });

    expectRefusal(
      await rejection(offer(service, { providerId: 'p2' })),
      422,
      'VALIDATION_ERROR',
      'Add a note explaining why you chose this provider over the suggestion.',
    );
    expect(tx.assignment.create).not.toHaveBeenCalled();

    await offer(service, {
      providerId: 'p2',
      overrideNote: 'Closer to the site.',
    });

    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        overrideNote: 'Closer to the site.',
        overriddenRules: [],
        score: { total: 89, factors: { area: 1 } },
      }) as unknown,
    });
    expect(effects.audit.map(({ action }) => action)).toEqual([
      'Assignment offered',
      'Dispatch suggestion overridden',
    ]);
  });

  it('records every failing overridable rule, with a null score for a provider the run excluded', async () => {
    const tx = offerTx(run(['p2']));
    const { service, effects } = build({
      tx,
      settings,
      providers: [
        dispatchProvider('p2'),
        dispatchProvider('p1', {
          serviceAreaIds: [],
          hasVerifiedCurrentBank: false,
        }),
      ],
    });

    await offer(service, { overrideNote: 'Customer asked for them.' });

    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempt: null,
        score: Prisma.JsonNull,
        overriddenRules: ['area', 'bank'],
      }) as unknown,
    });
    expect(effects.audit[1]).toMatchObject({
      action: 'Dispatch suggestion overridden',
      data: {
        changes: expect.objectContaining({
          rules: ['area', 'bank'],
        }) as unknown,
      },
    });
  });

  it('refuses an overridable failure without a note', async () => {
    const { service } = build({
      tx: offerTx(run([])),
      settings,
      providers: [dispatchProvider('p1', { committedJobs: 3 })],
    });

    expectRefusal(
      await rejection(offer(service)),
      422,
      'VALIDATION_ERROR',
      'Add a note explaining why you chose this provider over the suggestion.',
    );
  });

  it.each([
    ['E1', { verification: 'pending' }],
    ['E2', { reliabilityStatus: 'restricted' }],
    ['E4', { services: [] }],
    ['E5', { available: false }],
  ])('refuses a provider failing %s even with a note', async (_row, patch) => {
    const { service, tx } = build({
      tx: offerTx(run([])),
      settings,
      providers: [dispatchProvider('p1', patch)],
    });

    expectRefusal(
      await rejection(offer(service, { overrideNote: 'Please do it.' })),
      422,
      'VALIDATION_ERROR',
      'Choose an approved, available provider for this service.',
    );
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });

  it('refuses the request owner (E3)', async () => {
    const { service } = build({
      tx: offerTx(run([])),
      settings,
      providers: [dispatchProvider('p1', { userId: 'customer-1' })],
    });

    expectRefusal(
      await rejection(offer(service, { overrideNote: 'Please do it.' })),
      422,
      'VALIDATION_ERROR',
      "A provider can't be offered their own request.",
    );
  });

  it('refuses an unknown provider like an unapproved one', async () => {
    const { service } = build({ tx: offerTx(run([])), settings });

    expectRefusal(
      await rejection(offer(service)),
      422,
      'VALIDATION_ERROR',
      'Choose an approved, available provider for this service.',
    );
  });

  it('locks the provider and re-runs the rules from fresh data: a listed provider that now fails gets the 409', async () => {
    const tx = offerTx(run(['p1']));
    const { service, loader } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1')],
    });
    loader.one.mockResolvedValue(
      dispatchProvider('p1', { name: 'Acme Ltd', committedJobs: 3 }),
    );

    expectRefusal(
      await rejection(offer(service)),
      409,
      'STATE_CONFLICT',
      'Acme Ltd can no longer take this job (At capacity (3 of 3 jobs)). Refresh the ranked list.',
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });
});

describe('DispatchService.autoAssign (staff)', () => {
  const autoTx = () => ({
    serviceRequest: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...designRequestRow, autoAttempts: 2 }),
      update: jest.fn(),
    },
    assignment: {
      create: jest.fn().mockResolvedValue({ id: 'assignment-new' }),
    },
    providerProfile: { update: jest.fn() },
    dispatchRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }) },
  });
  const settings = { 'assignment.maxAutoAttempts': 3 };
  const auto = (
    service: DispatchService,
    dto: { resetAttempts?: boolean; note?: string } = {},
  ) => service.autoAssign('staff-1', 'XPR-00042', dto, undefined, '/url');

  it('stores every exclusion and keeps the reset note off the assignment', async () => {
    const tx = autoTx();
    const { service, effects } = build({
      tx,
      settings,
      providers: [
        dispatchProvider('p1'),
        dispatchProvider('p2', { serviceAreaIds: [] }),
      ],
    });

    await auto(service, {
      resetAttempts: true,
      note: 'Customer asked us to retry.',
    });

    expect(tx.dispatchRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: 'staff_auto',
        actorId: 'staff-1',
        at: now,
        excluded: [
          {
            providerId: 'p2',
            providerName: 'Provider p2',
            rule: 'area',
            reason: 'Doesn’t cover Ikeja',
          },
        ],
      }) as unknown,
    });
    const created = (
      tx.assignment.create.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >
    )[0][0];
    expect(created.data).toMatchObject({ attempt: 1, source: 'auto' });
    expect(created.data).not.toHaveProperty('note');
    expect(effects.audit[0]).toMatchObject({
      action: 'Assignment offered',
      data: { note: 'Customer asked us to retry.' },
    });
  });

  it('continues the attempt count without a reset', async () => {
    const tx = autoTx();
    const { service } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1')],
    });

    await auto(service);

    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attempt: 3 }) as unknown,
    });
  });

  it('gives staff the 409 when the top provider no longer qualifies after the lock', async () => {
    const tx = autoTx();
    const { service, loader } = build({
      tx,
      settings,
      providers: [dispatchProvider('p1'), dispatchProvider('p2')],
    });
    loader.one.mockResolvedValue(
      dispatchProvider('p1', { name: 'Acme Ltd', available: false }),
    );

    expectRefusal(
      await rejection(auto(service)),
      409,
      'STATE_CONFLICT',
      'Acme Ltd can no longer take this job (Not accepting new jobs). Refresh the ranked list.',
    );
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });

  it('asks staff to assign when nobody is eligible', async () => {
    const tx = autoTx();
    const { service, effects } = build({ tx, settings, providers: [] });

    await auto(service, { resetAttempts: true, note: 'Retry.' });

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        needsAssignmentReason: 'no_eligible',
        lastRunId: 'run-1',
        autoAttempts: 0,
      },
    });
    expect(effects.audit[0].action).toBe('Automatic assignment needs staff');
  });
});

describe('DispatchService.rankingRun', () => {
  it('evaluates and stores the run at one instant and leaves the request row alone', async () => {
    jest.useFakeTimers({ now });
    try {
      const prisma = {
        setting: { findMany: jest.fn().mockResolvedValue([]) },
        serviceRequest: {
          findUnique: jest.fn().mockResolvedValue(designRequestRow),
          update: jest.fn(),
        },
        location: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'district-1', name: 'Ikeja' },
            { id: 'city-1', name: 'Lagos' },
          ]),
        },
        dispatchRun: { create: jest.fn().mockResolvedValue({ id: 'run-9' }) },
      };
      const { service, loader } = build({
        prisma,
        providers: [
          dispatchProvider('p1'),
          dispatchProvider('p2', { serviceAreaIds: [] }),
        ],
      });

      const result = await service.rankingRun('staff-1', 'request-1');

      expect(loader.list).toHaveBeenCalledWith(now, 'request-1');
      expect(prisma.dispatchRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trigger: 'staff_view',
          at: now,
        }) as unknown,
      });
      expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
      expect(result.at).toEqual(now);
      expect(result.excluded).toEqual([
        {
          providerId: 'p2',
          providerName: 'Provider p2',
          rule: 'area',
          reason: 'Doesn’t cover Ikeja',
        },
      ]);
      expect(result.eligible.map(({ providerId }) => providerId)).toEqual([
        'p1',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DispatchService.review (04 §6.9)', () => {
  const pending = {
    id: 'a1',
    requestId: 'request-1',
    providerId: 'p1',
    providerUserId: 'user-p1',
    status: 'pending_approval',
  };
  const reviewTx = (request: Record<string, unknown> = {}) => ({
    assignment: {
      findFirst: jest.fn().mockResolvedValue(pending),
      update: jest.fn().mockResolvedValue(pending),
    },
    serviceRequest: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...designRequestRow, ...request }),
      update: jest.fn(),
    },
    requestAttachment: { count: jest.fn().mockResolvedValue(0) },
    quote: { findFirst: jest.fn().mockResolvedValue(null) },
    payment: { findFirst: jest.fn() },
    payout: { findFirst: jest.fn(), create: jest.fn() },
  });
  const review = (
    service: DispatchService,
    dto: {
      approve: boolean;
      note?: string;
      share?: { description: boolean; attachmentIds: string[] };
      overrideNote?: string;
    },
  ) => service.review('staff-1', 'XPR-00042', 'a1', dto, undefined, '/url');

  describe('reject', () => {
    it('tells the provider with the note, audits Assignment rejected and cascades', async () => {
      const tx = reviewTx();
      const { service, effects } = build({ tx });

      await review(service, { approve: false, note: 'Wrong skill set.' });

      expect(tx.assignment.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: expect.objectContaining({
          status: 'not_confirmed',
          endReason: 'acceptance_rejected',
          reviewNote: 'Wrong skill set.',
        }) as unknown,
      });
      expect(effects.audit[0]).toMatchObject({
        action: 'Assignment rejected',
        data: { note: 'Wrong skill set.' },
      });
      expect(effects.notify[0]).toEqual({
        event: 'assignment.not_confirmed',
        params: {
          assignmentId: 'a1',
          providerUserId: 'user-p1',
          requestCode: 'XPR-00042',
          note: 'Wrong skill set.',
        },
      });
      expect(effects.timerStops).toEqual([{ kind: 'T3.review', refId: 'a1' }]);
    });
  });

  describe('approve re-check', () => {
    it.each([
      ['E1', { verification: 'pending' }],
      ['E2', { userStatus: 'suspended' }],
      ['E3', { userId: 'customer-1' }],
      ['E4', { services: [] }],
    ])(
      'refuses with 409 when the provider now fails %s',
      async (_row, patch) => {
        const tx = reviewTx();
        const { service } = build({
          tx,
          providers: [dispatchProvider('p1', { name: 'Acme Ltd', ...patch })],
        });

        expectRefusal(
          await rejection(
            review(service, { approve: true, overrideNote: 'Fine by me.' }),
          ),
          409,
          'STATE_CONFLICT',
          'Acme Ltd is no longer approved for this service. Reject the acceptance instead.',
        );
        expect(tx.assignment.update).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['E5', { available: false }, 'Not accepting new jobs'],
      ['E6', { serviceAreaIds: [] }, 'Doesn’t cover Ikeja'],
      ['E8', { skills: {} }, 'Doesn’t offer Architectural plan'],
      ['E11', { hasVerifiedCurrentBank: false }, 'Bank details not verified'],
    ])(
      'asks for a note when the provider now fails %s',
      async (_row, patch, reason) => {
        const tx = reviewTx();
        const { service } = build({
          tx,
          providers: [dispatchProvider('p1', patch)],
        });

        expectRefusal(
          await rejection(review(service, { approve: true })),
          422,
          'VALIDATION_ERROR',
          `Add a note to confirm this provider despite: ${reason}.`,
        );
        expect(tx.assignment.update).not.toHaveBeenCalled();
      },
    );

    it('lists every reason and confirms with an override note, recording it in the audit', async () => {
      const tx = reviewTx();
      const { service, effects } = build({
        tx,
        providers: [
          dispatchProvider('p1', {
            available: false,
            hasVerifiedCurrentBank: false,
          }),
        ],
      });

      expectRefusal(
        await rejection(review(service, { approve: true })),
        422,
        'VALIDATION_ERROR',
        'Add a note to confirm this provider despite: Not accepting new jobs; Bank details not verified.',
      );

      await review(service, { approve: true, overrideNote: 'Called them.' });

      expect(effects.audit[0]).toMatchObject({
        action: 'Assignment approved',
        data: {
          changes: {
            overrideNote: 'Called them.',
            overriddenRules: ['available', 'bank'],
          },
        },
      });
    });

    it('does not re-check capacity or earlier assignments for the provider’s own offer', async () => {
      const tx = reviewTx();
      const { service } = build({
        tx,
        providers: [
          dispatchProvider('p1', {
            committedJobs: 9,
            earlierEndReasons: ['declined'],
          }),
        ],
      });

      await review(service, { approve: true });

      expect(tx.assignment.update).toHaveBeenCalled();
    });
  });

  describe('approve effects', () => {
    it('never creates a payout, even when the quote already has a payout amount (DUP-07, FD-7)', async () => {
      const tx = reviewTx();
      tx.quote.findFirst.mockResolvedValue({
        id: 'quote-1',
        payoutAmount: 90_000n,
        payoutAssignmentId: 'old-assignment',
      });
      const { service } = build({
        tx,
        providers: [dispatchProvider('p1')],
      });

      await review(service, { approve: true });

      expect(tx.payout.create).not.toHaveBeenCalled();
      expect(tx.payout.findFirst).not.toHaveBeenCalled();
    });

    it('defaults sharedDetails from the request’s shareOnConfirm', async () => {
      const tx = reviewTx({
        shareOnConfirm: { description: true, attachmentIds: ['file-1'] },
      });
      tx.requestAttachment.count.mockResolvedValue(1);
      const { service } = build({
        tx,
        providers: [dispatchProvider('p1')],
      });

      await review(service, { approve: true });

      expect(tx.requestAttachment.count).toHaveBeenCalledWith({
        where: { requestId: 'request-1', uploadId: { in: ['file-1'] } },
      });
      expect(tx.assignment.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: expect.objectContaining({
          status: 'accepted',
          sharedDetails: {
            description: true,
            attachmentIds: ['file-1'],
            fields: [],
            at: now.toISOString(),
            by: 'staff-1',
          },
        }) as unknown,
      });
    });

    it('uses an explicit share over the default', async () => {
      const tx = reviewTx();
      const { service } = build({
        tx,
        providers: [dispatchProvider('p1')],
      });

      await review(service, {
        approve: true,
        share: { description: false, attachmentIds: [] },
      });

      expect(tx.assignment.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: expect.objectContaining({
          sharedDetails: expect.objectContaining({
            description: false,
            attachmentIds: [],
          }) as unknown,
        }) as unknown,
      });
    });

    it('refuses attachments that are not on the request', async () => {
      const tx = reviewTx();
      tx.requestAttachment.count.mockResolvedValue(0);
      const { service } = build({
        tx,
        providers: [dispatchProvider('p1')],
      });

      expectRefusal(
        await rejection(
          review(service, {
            approve: true,
            share: { description: true, attachmentIds: ['stranger'] },
          }),
        ),
        422,
        'VALIDATION_ERROR',
        'Choose only files attached to this request to share with the provider.',
      );
    });

    it('moves a first match to matched, stops T3 and starts T7 from the pricing settings', async () => {
      const tx = reviewTx();
      const { service, effects } = build({
        tx,
        providers: [dispatchProvider('p1')],
        settings: {
          'pricing.stallReminderHours': 12,
          'pricing.stallEscalateHours': 30,
        },
      });

      await review(service, { approve: true, note: 'Looks right.' });

      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-1' },
        data: { status: 'matched', needsAssignmentReason: null },
      });
      expect(effects.timerStops[0]).toEqual({
        kind: 'T3.review',
        refId: 'a1',
      });
      expect(effects.timerStarts).toEqual([
        {
          kind: 'T7.reminder24h',
          dueAt: new Date(now.getTime() + 12 * hour),
          refId: 'a1',
          payload: undefined,
        },
        {
          kind: 'T7.stall48h',
          dueAt: new Date(now.getTime() + 30 * hour),
          refId: 'a1',
          payload: undefined,
        },
      ]);
      expect(effects.audit[0]).toMatchObject({
        action: 'Assignment approved',
        data: { note: 'Looks right.' },
      });
    });

    it('falls back to the registry defaults for T7', async () => {
      const tx = reviewTx();
      const { service, effects } = build({
        tx,
        providers: [dispatchProvider('p1')],
      });

      await review(service, { approve: true });

      expect(effects.timerStarts.map(({ dueAt }) => dueAt)).toEqual([
        new Date(now.getTime() + 24 * hour),
        new Date(now.getTime() + 48 * hour),
      ]);
    });
  });
});

describe('DispatchService.respond', () => {
  const respondTx = (profile: Record<string, unknown>) => ({
    assignment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'a1',
        providerId: 'p1',
        status: 'offered',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    providerProfile: {
      findUnique: jest.fn().mockResolvedValue({
        verification: 'approved',
        available: true,
        reliabilityStatus: 'normal',
        user: { status: 'active' },
        ...profile,
      }),
    },
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(designRequestRow),
    },
  });
  const accept = (service: DispatchService) =>
    service.respond(
      'user-p1',
      'XPR-00042',
      'a1',
      { accept: true },
      undefined,
      '/url',
    );

  it('refuses a restricted provider with the E2 message', async () => {
    const { service } = build({
      actor: providerActor,
      tx: respondTx({ reliabilityStatus: 'restricted' }),
    });

    expectRefusal(
      await rejection(accept(service)),
      422,
      'VALIDATION_ERROR',
      'Your profile must be approved and available to accept work.',
    );
  });

  it('starts T3 four working hours after the response, not four calendar hours', async () => {
    const tx = respondTx({});
    const { service, effects } = build({
      actor: providerActor,
      tx,
      settings: { 'calendar.holidays': [] },
    });

    await accept(service);

    // Saturday 12:00 UTC: the first working minute is Monday 08:00 WAT, so T3 is due Monday 12:00 WAT.
    expect(effects.timerStarts).toEqual([
      {
        kind: 'T3.review',
        dueAt: new Date('2026-10-26T11:00:00.000Z'),
        refId: 'a1',
        payload: undefined,
      },
    ]);
  });
});

describe('DispatchService.withdraw (04 §5.2 #14, §5.5, §5.6)', () => {
  const withdrawTx = (
    status: string,
    options: { sentQuotes?: string[]; schedules?: string[] } = {},
  ) => ({
    assignment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'a1',
        providerUserId: 'user-p1',
        status,
      }),
      update: jest.fn(),
    },
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(designRequestRow),
      update: jest.fn(),
    },
    quote: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.sentQuotes ?? []).map((id) => ({ id }))),
      updateMany: jest.fn(),
    },
    schedule: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.schedules ?? []).map((id) => ({ id }))),
      updateMany: jest.fn(),
    },
  });
  const withdraw = (service: DispatchService) =>
    service.withdraw(
      'staff-1',
      'XPR-00042',
      'a1',
      ' Customer changed scope. ',
      undefined,
      '/url',
    );

  it('withdraws an accepted provider: supersedes sent quotes, cancels open schedules and stops their timers', async () => {
    const tx = withdrawTx('accepted', {
      sentQuotes: ['q1'],
      schedules: ['s1', 's2'],
    });
    const { service, effects } = build({ tx });

    await withdraw(service);

    expect(tx.assignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({
        status: 'withdrawn',
        endReason: 'withdrawn',
        response: 'Customer changed scope.',
      }) as unknown,
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'under_review', needsAssignmentReason: 'withdrawn' },
    });
    expect(tx.quote.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', status: 'sent' },
      select: { id: true },
    });
    expect(tx.quote.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['q1'] } },
      data: { status: 'superseded' },
    });
    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      where: {
        requestId: 'request-1',
        status: { in: ['proposed', 'changes_requested', 'confirmed'] },
      },
      select: { id: true },
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] } },
      data: { status: 'cancelled' },
    });
    expect(effects.timerStops).toEqual(
      expect.arrayContaining([
        {
          kind: [
            'T1.reminder',
            'T1.expire',
            'T3.review',
            'T7.reminder24h',
            'T7.stall48h',
          ],
          refId: 'a1',
        },
        { kind: ['T8.reminder3d', 'T8.reminder1d', 'T8.expire'], refId: 'q1' },
        {
          kind: [
            'T11.reminder24h',
            'T11.staff48h',
            'T12.reminder24h',
            'T12.reminder2h',
            'T13.noShowCheck',
          ],
          refId: 's1',
        },
      ]),
    );
    expect(
      effects.timerStops.filter(({ refId }) => refId === 's2'),
    ).toHaveLength(1);
    expect(effects.audit[0]).toMatchObject({
      action: 'Assignment withdrawn',
      data: { changes: { wasAccepted: true, supersededQuoteIds: ['q1'] } },
    });
  });

  it('tells the provider with the real skill and district', async () => {
    const { service, effects } = build({ tx: withdrawTx('offered') });

    await withdraw(service);

    expect(effects.notify).toEqual([
      {
        event: 'request.offer_withdrawn',
        params: {
          assignmentId: 'a1',
          providerUserId: 'user-p1',
          requestCode: 'XPR-00042',
          service: 'Design',
          district: 'Ikeja',
          skill: 'Architectural plan',
        },
      },
    ]);
  });

  it('leaves quotes and schedules alone when there are none', async () => {
    const tx = withdrawTx('offered');
    const { service } = build({ tx });

    await withdraw(service);

    expect(tx.quote.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an assignment that is no longer current', async () => {
    const tx = withdrawTx('offered');
    tx.assignment.findFirst.mockResolvedValue(null);
    const { service } = build({ tx });

    expectRefusal(
      await rejection(withdraw(service)),
      409,
      'STATE_CONFLICT',
      'This offer is no longer current.',
    );
  });
});

describe('DispatchService.replace (04 §5.2 #21, §6.19)', () => {
  const replaceTx = (
    options: { schedules?: string[]; payouts?: string[] } = {},
  ) => ({
    assignment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'a1',
        providerUserId: 'user-p1',
        status: 'accepted',
        workStarted: false,
      }),
      update: jest.fn(),
    },
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue(designRequestRow),
      update: jest.fn(),
    },
    quote: { updateMany: jest.fn() },
    schedule: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.schedules ?? []).map((id) => ({ id }))),
      updateMany: jest.fn(),
    },
    payout: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.payouts ?? []).map((id) => ({ id }))),
      updateMany: jest.fn(),
    },
  });
  const replace = (
    service: DispatchService,
    dto: { note: string; workStarted?: boolean } = { note: ' Provider left. ' },
  ) => service.replace('staff-1', 'XPR-00042', 'a1', dto, undefined, '/url');

  it('ends the assignment, keeps the paid quote and sends the request back to dispatch', async () => {
    const tx = replaceTx();
    const { service } = build({ tx });

    await replace(service, { note: ' Provider left. ', workStarted: true });

    expect(tx.assignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({
        status: 'replaced',
        endReason: 'replaced',
        workStarted: true,
      }) as unknown,
    });
    expect(tx.quote.updateMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', status: { in: ['accepted', 'sent'] } },
      data: { providerChangedAt: now },
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'under_review', needsAssignmentReason: 'replaced' },
    });
  });

  it('cancels open schedules and stops T11 to T13 for each, and T7', async () => {
    const tx = replaceTx({ schedules: ['s1'] });
    const { service, effects } = build({ tx });

    await replace(service);

    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] } },
      data: { status: 'cancelled' },
    });
    expect(effects.timerStops).toEqual([
      {
        kind: [
          'T11.reminder24h',
          'T11.staff48h',
          'T12.reminder24h',
          'T12.reminder2h',
          'T13.noShowCheck',
        ],
        refId: 's1',
      },
      { kind: ['T7.reminder24h', 'T7.stall48h'], refId: 'a1' },
    ]);
  });

  it('cancels the old assignment’s non-paid primary payout with a reason (FD-7)', async () => {
    const tx = replaceTx({ payouts: ['payout-1'] });
    const { service } = build({ tx });

    await replace(service);

    expect(tx.payout.findMany).toHaveBeenCalledWith({
      where: {
        assignmentId: 'a1',
        kind: 'primary',
        status: { notIn: ['paid', 'processing', 'cancelled', 'reversed'] },
      },
      select: { id: true },
    });
    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['payout-1'] } },
      data: {
        status: 'cancelled',
        holdReason: 'Provider replaced on this request.',
        holdSource: 'replacement',
        version: { increment: 1 },
      },
    });
  });

  it('leaves payouts alone when there is nothing to cancel', async () => {
    const tx = replaceTx();
    const { service } = build({ tx });

    await replace(service);

    expect(tx.payout.updateMany).not.toHaveBeenCalled();
  });

  it('notifies the customer and the old provider and audits the old assignment id', async () => {
    const tx = replaceTx({ payouts: ['payout-1'] });
    const { service, effects } = build({ tx });

    await replace(service);

    expect(effects.notify).toEqual([
      {
        event: 'assignment.replaced_customer',
        params: { requestCode: 'XPR-00042' },
      },
      {
        event: 'assignment.replaced_provider',
        params: {
          assignmentId: 'a1',
          providerUserId: 'user-p1',
          requestCode: 'XPR-00042',
          service: 'Design',
          district: 'Ikeja',
          skill: 'Architectural plan',
        },
      },
    ]);
    expect(effects.audit).toEqual([
      {
        action: 'Assignment replaced',
        data: {
          resourceType: 'assignment',
          resourceId: 'a1',
          note: 'Provider left.',
          changes: {
            oldAssignmentId: 'a1',
            workStarted: false,
            cancelledPayoutIds: ['payout-1'],
          },
        },
      },
    ]);
  });
});

describe('DispatchService.shareDetails (04 §4.5)', () => {
  it('merges into the existing sharedDetails and keeps the description flag', async () => {
    const tx = {
      assignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'a1',
          providerUserId: 'user-p1',
          sharedDetails: {
            description: true,
            attachmentIds: ['file-1'],
            fields: ['access'],
            at: 'earlier',
            by: 'staff-0',
          },
        }),
        update: jest.fn(),
      },
      requestAttachment: { count: jest.fn().mockResolvedValue(1) },
    };
    const { service } = build({ tx });

    await service.shareDetails(
      'staff-1',
      'XPR-00042',
      { attachmentIds: ['file-2'], fields: ['address'] },
      undefined,
      '/url',
    );

    expect(tx.assignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: {
        sharedDetails: {
          description: true,
          attachmentIds: ['file-1', 'file-2'],
          fields: ['access', 'address'],
          at: now.toISOString(),
          by: 'staff-1',
        },
      },
    });
  });

  it('refuses attachments that are not on the request', async () => {
    const tx = {
      assignment: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'a1', providerUserId: 'user-p1' }),
        update: jest.fn(),
      },
      requestAttachment: { count: jest.fn().mockResolvedValue(0) },
    };
    const { service } = build({ tx });

    expectRefusal(
      await rejection(
        service.shareDetails(
          'staff-1',
          'XPR-00042',
          { attachmentIds: ['stranger'] },
          undefined,
          '/url',
        ),
      ),
      422,
      'VALIDATION_ERROR',
      'Choose only files attached to this request to share with the provider.',
    );
    expect(tx.assignment.update).not.toHaveBeenCalled();
  });
});
