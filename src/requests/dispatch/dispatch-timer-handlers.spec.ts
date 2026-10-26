import { ENGINE_ACTOR } from '../../platform/actor/actor.types';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { systemCommandKit, timerFixture } from '../system-command.testkit';
import { designRequestRow, dispatchProvider } from './dispatch.testkit';
import {
  DispatchTimerHandlers,
  cascadeTrigger,
} from './dispatch-timer-handlers';

const now = new Date('2026-10-24T12:00:00.000Z');
const hour = 60 * 60 * 1000;

function setup(
  options: {
    snap?: Record<string, unknown>;
    tx?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    providers?: unknown[];
  } = {},
) {
  const kit = systemCommandKit({
    now,
    snap: options.snap as never,
    tx: options.tx ?? {},
    settings: options.settings,
  });
  const providers = (options.providers ?? []) as Array<{ id: string }>;
  const loader = {
    list: jest.fn().mockResolvedValue(providers),
    one: jest.fn((id: string): Promise<unknown> =>
      Promise.resolve(providers.find((item) => item.id === id) ?? null),
    ),
  };
  const registry = new TimerRegistry();
  new DispatchTimerHandlers(registry, kit.runner, loader as never);
  const fire = (kind: string, overrides = {}) =>
    registry.get(kind)?.(timerFixture(kind, overrides)) as Promise<void>;
  return { fire, loader, ...kit };
}

describe('T1 and T3 dispatch timer handlers', () => {
  it('reminds an offered, unexpired assignment without a version bump', async () => {
    const tx = {
      assignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'a-1',
          providerUserId: 'provider-1',
          expiresAt: new Date(now.getTime() + hour),
        }),
      },
    };
    const { fire, effects, runs } = setup({ tx });

    await fire('T1.reminder', { refId: 'a-1' });

    expect(runs[0].opts).toEqual({ bumpVersion: false });
    expect(effects.notify[0]).toMatchObject({
      event: 'assignment.reminder',
      params: { assignmentId: 'a-1', providerUserId: 'provider-1' },
    });
  });

  it.each([
    ['missing', null],
    [
      'expired',
      {
        id: 'a-1',
        providerUserId: 'p',
        expiresAt: new Date(now.getTime() - hour),
      },
    ],
  ])('does not remind a %s offer', async (_name, assignment) => {
    const tx = {
      assignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
    };
    const { fire, effects, runs } = setup({ tx });

    await fire('T1.reminder', { refId: 'a-1' });

    expect(runs[0].result).toEqual({ changed: false });
    expect(effects.notify).toEqual([]);
  });

  describe('T1.expire', () => {
    const offered = (dispatchMode: string, autoAttempts: number) => ({
      id: 'a-1',
      requestId: 'request-1',
      providerId: 'provider-profile-1',
      providerUserId: 'provider-1',
      status: 'offered',
      expiresAt: new Date(now.getTime() - 1000),
      request: { dispatchMode, autoAttempts },
    });
    const expireTx = (assignment: unknown, updated = 1) => ({
      assignment: {
        findFirst: jest.fn().mockResolvedValue(assignment),
        updateMany: jest.fn().mockResolvedValue({ count: updated }),
      },
      providerReliabilityEvent: { createMany: jest.fn() },
      serviceRequest: { update: jest.fn() },
    });

    it('expires the offer, audits it and queues the next cascade in auto mode', async () => {
      const tx = expireTx(offered('auto', 1));
      const { fire, effects, runs } = setup({
        tx,
        settings: { 'assignment.maxAutoAttempts': 3 },
      });

      await fire('T1.expire', { refId: 'a-1' });

      expect(runs[0].result).toEqual({ changed: true });
      expect(tx.assignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'expired',
            endedAt: now,
          }) as unknown,
        }),
      );
      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-1' },
        data: { status: 'under_review', needsAssignmentReason: null },
      });
      expect(effects.audit[0].action).toBe('Offer expired');
      expect(effects.notify.map((entry) => entry.event)).toEqual([
        'assignment.expired',
      ]);
      expect(effects.cascades).toEqual(['cascade']);
    });

    it('asks staff to assign in manual mode', async () => {
      const tx = expireTx(offered('manual', 0));
      const { fire, effects } = setup({ tx });

      await fire('T1.expire', { refId: 'a-1' });

      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-1' },
        data: { status: 'under_review', needsAssignmentReason: 'expired' },
      });
      expect(effects.notify.map((entry) => entry.event)).toEqual([
        'assignment.expired',
        'request.needs_manual_assignment',
      ]);
      expect(effects.approvalOpens).toEqual([
        { kind: 'needs_assignment', itemId: 'request-1' },
      ]);
      expect(effects.cascades).toEqual([]);
    });

    it.each([
      [
        'an offer that is already answered',
        { ...offered('auto', 0), status: 'accepted' },
        1,
      ],
      [
        'an offer that has not expired yet',
        { ...offered('auto', 0), expiresAt: new Date(now.getTime() + hour) },
        1,
      ],
      ['an offer another process just claimed', offered('auto', 0), 0],
      ['a missing offer', null, 1],
    ])('does nothing for %s', async (_name, assignment, count) => {
      const tx = expireTx(assignment, count);
      const { fire, effects, runs } = setup({ tx });

      await fire('T1.expire', { refId: 'a-1' });

      expect(runs[0].result).toEqual({ changed: false });
      expect(tx.serviceRequest.update).not.toHaveBeenCalled();
      expect(effects.notify).toEqual([]);
      expect(effects.cascades).toEqual([]);
    });
  });

  describe('T3.review', () => {
    it('notifies while the assignment awaits staff review', async () => {
      const tx = {
        assignment: { findFirst: jest.fn().mockResolvedValue({ id: 'a-1' }) },
      };
      const { fire, effects, runs } = setup({ tx });

      await fire('T3.review', { refId: 'a-1' });

      expect(runs[0].opts).toEqual({ bumpVersion: false });
      expect(effects.notify[0].event).toBe('assignment.accepted');
    });

    it('does nothing once the review is decided', async () => {
      const tx = {
        assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const { fire, runs } = setup({ tx });

      await fire('T3.review', { refId: 'a-1' });

      expect(runs[0].result).toEqual({ changed: false });
    });
  });
});

describe('dispatch.cascade handler', () => {
  const baseRequest = {
    id: 'request-1',
    ownerId: 'customer-1',
    service: 'plumbing',
    details: {},
    cityId: 'city-1',
    districtId: 'district-1',
    startDate: '2026-11-01',
    dispatchMode: 'auto',
    autoAttempts: 0,
    needsAssignmentReason: null as string | null,
  };
  const cascadeTx = (request: Record<string, unknown>) => ({
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue({ ...baseRequest, ...request }),
      update: jest.fn(),
    },
    assignment: {
      create: jest.fn().mockResolvedValue({ id: 'assignment-new' }),
    },
    providerProfile: { update: jest.fn() },
    dispatchRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
  });

  it('runs as the dispatch engine', async () => {
    const tx = cascadeTx({});
    const { fire, runs } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade');

    expect(runs[0].opts).toEqual({ actor: ENGINE_ACTOR });
  });

  it.each([
    ['not under review', { status: 'matched' }],
    ['intake not approved', { intake: { state: 'pending' } }],
    [
      'an assignment is already live',
      {
        currentAssignment: {
          status: 'offered',
          attempt: 1,
          expiresAt: new Date('2026-10-25T12:00:00.000Z'),
        },
      },
    ],
    ['a cancellation is pending', { pendingCancellation: true }],
    ['the customer is suspended', { customerStanding: 'suspended' }],
  ])('does nothing when %s', async (_name, snap) => {
    const tx = cascadeTx({});
    const { fire, effects, runs } = setup({ tx, snap });

    await fire('dispatch.cascade');

    expect(runs[0].result).toEqual({ changed: false });
    expect(tx.dispatchRun.create).not.toHaveBeenCalled();
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(effects.notify).toEqual([]);
  });

  it('records the payload trigger on the dispatch run', async () => {
    const tx = cascadeTx({});
    const { fire } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade', { payload: { trigger: 'intake_approved' } });

    expect(tx.dispatchRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: 'intake_approved',
        at: now,
      }) as unknown,
    });
  });

  it('falls back to a plain cascade for a missing or unknown trigger', () => {
    expect(cascadeTrigger({ payload: null })).toBe('cascade');
    expect(
      cascadeTrigger({ payload: { trigger: 'provider_standing_changed' } }),
    ).toBe('cascade');
    expect(cascadeTrigger({ payload: { trigger: 'edited' } })).toBe('edited');
  });

  it('writes the audit row and notice when nobody is eligible', async () => {
    const tx = cascadeTx({});
    const { fire, effects } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        needsAssignmentReason: 'no_eligible',
        lastRunId: 'run-1',
        autoAttempts: 0,
      },
    });
    expect(effects.audit[0]).toMatchObject({
      action: 'Automatic assignment needs staff',
    });
    expect(effects.notify[0].event).toBe('request.needs_manual_assignment');
  });

  it('keeps an existing needs-assignment reason in manual mode', async () => {
    const tx = cascadeTx({
      dispatchMode: 'manual',
      needsAssignmentReason: 'declined',
    });
    const { fire, effects } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade');

    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(effects.audit[0].data).toEqual({ changes: { reason: 'declined' } });
    expect(effects.notify[0].event).toBe('request.needs_manual_assignment');
  });

  it('sets manual_mode in manual mode when no reason exists yet', async () => {
    const tx = cascadeTx({ dispatchMode: 'manual' });
    const { fire } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { needsAssignmentReason: 'manual_mode' },
    });
  });

  it('sets limit_reached in auto mode once the attempts are used', async () => {
    const tx = cascadeTx({ autoAttempts: 3 });
    const { fire, effects } = setup({
      tx,
      settings: { 'assignment.maxAutoAttempts': 3 },
    });

    await fire('dispatch.cascade');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { needsAssignmentReason: 'limit_reached' },
    });
    expect(effects.approvalOpens).toEqual([
      { kind: 'needs_assignment', itemId: 'request-1' },
    ]);
  });
});

describe('dispatch.cascade offers', () => {
  // 2026-10-24 12:00 UTC is a Saturday; the provider works Monday to Friday.
  const designTx = (request: Record<string, unknown> = {}) => ({
    serviceRequest: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...designRequestRow, ...request }),
      update: jest.fn(),
    },
    assignment: {
      create: jest.fn().mockResolvedValue({ id: 'assignment-new' }),
    },
    providerProfile: { update: jest.fn() },
    dispatchRun: { create: jest.fn().mockResolvedValue({ id: 'run-1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
  });
  const settings = {
    'assignment.maxAutoAttempts': 3,
    'assignment.offerExpiryHours': 24,
    'assignment.offerMinWorkingHours': 4,
  };

  it('applies the skill from the catalogue skill field (E8) and shows the real district', async () => {
    const tx = designTx();
    const wrongSkill = dispatchProvider('p-wrong', { skills: { Design: [] } });
    const right = dispatchProvider('p-right');
    const { fire, effects } = setup({
      tx,
      settings,
      providers: [wrongSkill, right],
    });

    await fire('dispatch.cascade');

    expect(tx.dispatchRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        excluded: [
          expect.objectContaining({
            providerId: 'p-wrong',
            rule: 'skill',
            reason: 'Doesn’t offer Architectural plan',
          }),
        ] as unknown,
      }) as unknown,
    });
    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerId: 'p-right',
        source: 'auto',
        attempt: 1,
        rankingRunId: 'run-1',
      }) as unknown,
    });
    expect(effects.notify[0]).toMatchObject({
      event: 'assignment.offered',
      params: {
        skill: 'Architectural plan',
        district: 'Ikeja',
        service: 'Design',
      },
    });
  });

  it('uses the effective start date for E7', async () => {
    const tx = designTx({
      service: 'Waste management',
      details: { wasteType: 'Commercial', pickupDate: '2026-11-01' },
      startDate: '2026-11-03',
    });
    // 2026-11-01 is a Sunday; the provider has no Sunday hours.
    const provider = dispatchProvider('p1', {
      services: ['Waste management'],
      skills: { 'Waste management': ['Commercial'] },
    });
    const { fire, effects } = setup({ tx, settings, providers: [provider] });

    await fire('dispatch.cascade');

    expect(tx.dispatchRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        excluded: [
          expect.objectContaining({
            rule: 'day',
            reason: 'Doesn’t work on Sundays',
          }),
        ] as unknown,
      }) as unknown,
    });
    expect(effects.notify[0].event).toBe('request.needs_manual_assignment');
  });

  it('extends the offer expiry to the provider’s fourth working hour (04 §6.7)', async () => {
    // The run is on Saturday 2026-10-24: the plain 24 h window ends on Sunday with no working hour in it.
    const tx = designTx();
    const { fire, effects } = setup({
      tx,
      settings,
      providers: [dispatchProvider('p1')],
    });

    await fire('dispatch.cascade');

    const created = (
      tx.assignment.create.mock.calls as Array<
        [{ data: { expiresAt: Date; offeredAt: Date } }]
      >
    )[0][0];
    expect(created.data.offeredAt).toEqual(now);
    expect(created.data.expiresAt.getTime()).toBeGreaterThan(
      now.getTime() + 24 * hour,
    );
    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T1.reminder',
      'T1.expire',
    ]);
    expect(effects.timerStarts[1].dueAt).toEqual(created.data.expiresAt);
  });

  it('moves to the next ranked provider when the first no longer qualifies after the lock', async () => {
    const tx = designTx();
    const first = dispatchProvider('p-first', {
      serviceAreaIds: ['district-1'],
    });
    const second = dispatchProvider('p-second', { serviceAreaIds: ['city-1'] });
    const { fire, loader } = setup({
      tx,
      settings,
      providers: [first, second],
    });
    // A concurrent offer filled the first provider's last slot.
    loader.one.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'p-first' ? { ...first, committedJobs: first.capacity } : second,
      ),
    );

    await fire('dispatch.cascade');

    expect(loader.one).toHaveBeenCalledWith('p-first', now, 'request-1', tx);
    expect(tx.assignment.create).toHaveBeenCalledTimes(1);
    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerId: 'p-second' }) as unknown,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('needs staff when every ranked provider fails the re-check', async () => {
    const tx = designTx();
    const only = dispatchProvider('p-only');
    const { fire, loader, effects } = setup({
      tx,
      settings,
      providers: [only],
    });
    loader.one.mockResolvedValue({ ...only, available: false });

    await fire('dispatch.cascade');

    expect(tx.assignment.create).not.toHaveBeenCalled();
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        needsAssignmentReason: 'no_eligible',
        lastRunId: 'run-1',
        autoAttempts: 0,
      },
    });
    expect(effects.notify[0].event).toBe('request.needs_manual_assignment');
  });

  it('loads providers inside the command transaction', async () => {
    const tx = designTx();
    const { fire, loader } = setup({ tx, settings, providers: [] });

    await fire('dispatch.cascade');

    expect(loader.list).toHaveBeenCalledWith(now, 'request-1', tx);
  });

  it('counts the offer and clears the reason', async () => {
    const tx = designTx({ autoAttempts: 1 });
    const { fire } = setup({
      tx,
      settings,
      providers: [dispatchProvider('p1')],
    });

    await fire('dispatch.cascade');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: {
        autoAttempts: 2,
        needsAssignmentReason: null,
        lastRunId: 'run-1',
      },
    });
  });
});
