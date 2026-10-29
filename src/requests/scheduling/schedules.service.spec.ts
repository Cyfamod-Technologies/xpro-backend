import { Prisma } from '@prisma/client';
import type { ActorContext } from '../../platform/actor/actor.types';
import { systemCommandKit } from '../system-command.testkit';
import { SchedulesService } from './schedules.service';

const NOW = new Date('2026-10-24T12:00:00.000Z');
// Monday 26 Oct 2026, 10:00-12:00 WAT.
const START = new Date('2026-10-26T09:00:00.000Z');
const END = new Date('2026-10-26T11:00:00.000Z');

const staffActor = {
  userId: 'staff-1',
  kind: 'staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    permissions: new Set(['schedule.manage']),
    canOwn: true,
    isSuperAdmin: false,
  },
} as unknown as ActorContext;
const customerActor = {
  userId: 'customer-1',
  kind: 'customer',
  platformRoles: ['customer'],
  accountActive: true,
} as unknown as ActorContext;
const providerActor = {
  userId: 'provider-user-1',
  kind: 'provider',
  platformRoles: ['provider'],
  accountActive: true,
} as unknown as ActorContext;

const activeProfile = {
  workingHours: { mon: { start: '08:00', end: '17:00' } },
  timeOff: [],
  verification: 'approved',
  reliabilityStatus: 'normal',
  user: { status: 'active' },
};

type Tx = ReturnType<typeof buildTx>;

function buildTx(options: {
  confirmed?: Record<string, unknown> | null;
  overlap?: { startAt: Date; endAt: Date } | null;
  target?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  payoutAmount?: number | null;
  confirmUpdate?: () => Promise<unknown>;
}) {
  const schedule = {
    findFirst: jest
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.providerId) return Promise.resolve(options.overlap ?? null);
        if (where.status === 'confirmed')
          return Promise.resolve(options.confirmed ?? null);
        return Promise.resolve(options.target ?? null);
      }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        data.status === 'confirmed' && options.confirmUpdate
          ? options.confirmUpdate()
          : Promise.resolve({}),
      ),
    create: jest.fn().mockResolvedValue({ id: 'schedule-new' }),
  };
  return {
    approvalDeadline: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    assignment: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'assignment-1', providerId: 'provider-1' }),
    },
    quote: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'quote-1',
        payoutAssignmentId: 'assignment-1',
        payoutAmount:
          options.payoutAmount === undefined ? 5_000 : options.payoutAmount,
      }),
    },
    providerProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.profile === undefined ? activeProfile : options.profile,
        ),
    },
    schedule,
    serviceRequest: { update: jest.fn() },
  };
}

function setup(
  actor: ActorContext,
  tx: Tx,
  snap: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  const kit = systemCommandKit({
    tx,
    now: NOW,
    settings,
    snap: {
      status: 'ready_to_schedule',
      ownerId: 'customer-1',
      currentProviderUserId: 'provider-user-1',
      providerStanding: 'active',
      providerCard: { businessName: null, firstName: 'Alex' },
      currentSchedule: null,
      ...snap,
    } as never,
  });
  const service = new SchedulesService(
    {} as never,
    { resolve: jest.fn().mockResolvedValue(actor) } as never,
    kit.runner,
  );
  return { service, ...kit };
}

const propose = (service: SchedulesService) =>
  service.propose(
    'staff-1',
    'XPR-00042',
    { startAt: START.toISOString(), endAt: END.toISOString() },
    undefined,
    '/url',
  );
const respond = (
  service: SchedulesService,
  userId: string,
  dto: { accept: boolean; note?: string },
) =>
  service.respond(
    { id: userId } as never,
    'XPR-00042',
    'schedule-1',
    dto,
    undefined,
    '/url',
  );

const proposedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'schedule-1',
  requestId: 'request-1',
  providerId: 'provider-1',
  status: 'proposed',
  customer: 'accepted',
  provider: 'pending',
  startAt: START,
  endAt: END,
  replacesScheduleId: null,
  ...overrides,
});
const proposedSnap = (overrides: Record<string, unknown> = {}) => ({
  currentSchedule: {
    status: 'proposed',
    customer: 'accepted',
    provider: 'pending',
    startAt: START,
    endAt: END,
    changeRequests: [],
  },
  ...overrides,
});

describe('SchedulesService.propose', () => {
  it('marks the confirmed row’s open change requests handled and starts the new row empty (D-05)', async () => {
    const tx = buildTx({
      confirmed: {
        id: 'schedule-old',
        changeRequests: [
          { by: 'customer', note: 'Away', at: 't1', handledAt: null },
          { party: 'provider', note: 'Sick', createdAt: 't2' },
        ],
      },
    });
    const { service } = setup(staffActor, tx, { status: 'scheduled' });

    await propose(service);

    expect(tx.schedule.update).toHaveBeenCalledWith({
      where: { id: 'schedule-old' },
      data: {
        changeRequests: [
          {
            by: 'customer',
            note: 'Away',
            at: 't1',
            handledAt: NOW.toISOString(),
          },
          {
            by: 'provider',
            note: 'Sick',
            at: 't2',
            handledAt: NOW.toISOString(),
          },
        ],
      },
    });
    expect(tx.schedule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replacesScheduleId: 'schedule-old',
        changeRequests: [],
      }) as unknown,
    });
  });

  it('closes the schedule_needed and schedule_change items when a slot is proposed (02 §6.11)', async () => {
    const found = jest
      .fn()
      .mockResolvedValue([
        { kind: 'schedule_change', itemId: 'schedule-declined' },
      ]);
    const tx = Object.assign(buildTx({}), {
      approvalDeadline: { findMany: found },
    });
    const { service, effects } = setup(staffActor, tx);

    await propose(service);

    expect(effects.approvalCloses).toEqual([
      { kind: 'schedule_needed', itemId: 'request-1', reason: 'proposed' },
      {
        kind: 'schedule_change',
        itemId: 'schedule-declined',
        reason: 'proposed',
      },
    ]);
  });

  it('leaves a confirmed row with no change requests alone', async () => {
    const tx = buildTx({
      confirmed: { id: 'schedule-old', changeRequests: [] },
    });
    const { service } = setup(staffActor, tx, { status: 'scheduled' });

    await propose(service);

    expect(tx.schedule.update).not.toHaveBeenCalled();
  });

  it('is allowed while the job is held before work started (D-06)', async () => {
    const tx = buildTx({
      confirmed: { id: 'schedule-old', changeRequests: [] },
    });
    const { service, effects } = setup(staffActor, tx, {
      status: 'blocked',
      hold: { kind: 'staff', previousStatus: 'scheduled' },
    });

    await propose(service);

    expect(tx.schedule.create).toHaveBeenCalled();
    expect(effects.audit[0].action).toBe('Schedule proposed');
  });

  it.each(['in_progress', 'completion_pending', 'acknowledged'])(
    'refuses %s with the execution message (D-06)',
    async (status) => {
      const { service } = setup(staffActor, buildTx({}), { status });

      await expect(propose(service)).rejects.toMatchObject({
        status: 409,
        message: 'This job has already entered execution.',
      });
    },
  );

  it('refuses a delisted provider read under the lock (D-08)', async () => {
    const tx = buildTx({
      profile: { ...activeProfile, verification: 'delisted' },
    });
    const { service } = setup(staffActor, tx);

    await expect(propose(service)).rejects.toMatchObject({
      message:
        'This provider is suspended. Replace them or wait for reactivation.',
    });
    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it.each([
    ['restricted', { reliabilityStatus: 'restricted' }],
    ['a suspended account', { user: { status: 'suspended' } }],
  ])('refuses a provider blocked as %s (D-08)', async (_name, patch) => {
    const tx = buildTx({ profile: { ...activeProfile, ...patch } });
    const { service } = setup(staffActor, tx);

    await expect(propose(service)).rejects.toMatchObject({ status: 409 });
  });

  it('does not treat an under_review provider as blocked', async () => {
    const tx = buildTx({
      profile: { ...activeProfile, reliabilityStatus: 'under_review' },
    });
    const { service } = setup(staffActor, tx);

    await propose(service);

    expect(tx.schedule.create).toHaveBeenCalled();
  });

  it('checks the payout row before the standing row (D-08)', async () => {
    const tx = buildTx({
      payoutAmount: null,
      profile: { ...activeProfile, verification: 'delisted' },
    });
    const { service } = setup(staffActor, tx);

    await expect(propose(service)).rejects.toMatchObject({
      message: "Set the new provider's payout before scheduling.",
    });
  });

  it('quotes the conflicting appointment in the overlap message (D-32)', async () => {
    const tx = buildTx({
      overlap: {
        startAt: new Date('2026-10-26T08:00:00.000Z'),
        endAt: new Date('2026-10-26T09:30:00.000Z'),
      },
    });
    const { service } = setup(staffActor, tx);

    await expect(propose(service)).rejects.toMatchObject({
      message:
        'This provider already has an appointment between 09:00 and 10:30. Choose another time.',
    });
  });

  it('locks the provider before reading the calendar', async () => {
    const tx = buildTx({});
    const { service } = setup(staffActor, tx);

    await propose(service);

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.providerProfile.findUnique.mock.invocationCallOrder[0],
    );
  });
});

describe('SchedulesService.respond', () => {
  const lockOrder = (tx: Tx) => tx.$queryRaw.mock.invocationCallOrder[0];

  it('takes the provider row lock before the overlap query on a second acceptance (D-04)', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service } = setup(providerActor, tx, proposedSnap());

    await respond(service, 'provider-user-1', { accept: true });

    const overlapCall = tx.schedule.findFirst.mock.calls.findIndex(
      ([args]) => (args as { where: { providerId?: string } }).where.providerId,
    );
    expect(lockOrder(tx)).toBeLessThan(
      tx.schedule.findFirst.mock.invocationCallOrder[overlapCall],
    );
  });

  it('opens a schedule_change item when a party declines the slot, and closes none', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service, effects } = setup(providerActor, tx, proposedSnap());

    await respond(service, 'provider-user-1', {
      accept: false,
      note: 'I am away that day.',
    });

    expect(effects.approvalOpens).toEqual([
      { kind: 'schedule_change', itemId: 'schedule-1' },
    ]);
    expect(effects.approvalCloses).toEqual([]);
  });

  it('closes the schedule_change items once both parties confirm', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service, effects } = setup(providerActor, tx, proposedSnap());

    await respond(service, 'provider-user-1', { accept: true });

    expect(effects.approvalCloses).toEqual([]);
    expect(tx.approvalDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { in: ['schedule_change'] },
        }) as unknown,
      }),
    );
  });

  it('sets the status to scheduled only from ready_to_schedule (D-07)', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service } = setup(providerActor, tx, proposedSnap());

    await respond(service, 'provider-user-1', { accept: true });

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'scheduled' },
    });
  });

  it.each([
    ['scheduled', {}],
    ['blocked', { hold: { kind: 'staff', previousStatus: 'scheduled' } }],
  ])('leaves the status alone when %s (D-07)', async (status, extra) => {
    const tx = buildTx({
      target: proposedRow({ replacesScheduleId: 'schedule-old' }),
    });
    const { service, effects } = setup(
      providerActor,
      tx,
      proposedSnap({ status, ...extra }),
    );

    await respond(service, 'provider-user-1', { accept: true });

    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'schedule-old', status: 'confirmed' },
      data: { status: 'superseded' },
    });
    expect(effects.audit[0].action).toBe('Schedule confirmed');
  });

  it.each(['in_progress', 'completion_pending'])(
    'refuses a confirmation once the job is %s (D-07)',
    async (status) => {
      const tx = buildTx({ target: proposedRow() });
      const { service } = setup(providerActor, tx, proposedSnap({ status }));

      await expect(
        respond(service, 'provider-user-1', { accept: true }),
      ).rejects.toMatchObject({
        status: 409,
        message: 'This schedule is no longer awaiting confirmation.',
      });
      expect(tx.schedule.update).not.toHaveBeenCalled();
    },
  );

  it('maps the exclusion violation on confirmation to the second-confirmation 409 (D-04)', async () => {
    const tx = buildTx({
      target: proposedRow(),
      confirmUpdate: () =>
        Promise.reject(
          new Prisma.PrismaClientUnknownRequestError(
            'conflicting key value violates exclusion constraint "schedules_no_confirmed_overlap"',
            { clientVersion: 'test' },
          ),
        ),
    });
    const { service } = setup(providerActor, tx, proposedSnap());

    await expect(
      respond(service, 'provider-user-1', { accept: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
      message:
        'This date no longer works for the provider. XPro will propose a new one.',
    });
    expect(tx.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('rethrows other database errors on confirmation unchanged', async () => {
    const boom = new Error('connection lost');
    const tx = buildTx({
      target: proposedRow(),
      confirmUpdate: () => Promise.reject(boom),
    });
    const { service } = setup(providerActor, tx, proposedSnap());

    await expect(
      respond(service, 'provider-user-1', { accept: true }),
    ).rejects.toBe(boom);
  });

  it.each([
    ['delisted', { verification: 'delisted' }],
    ['restricted', { reliabilityStatus: 'restricted' }],
    ['suspended', { user: { status: 'suspended' } }],
  ])(
    'refuses a second confirmation for a %s provider (D-08)',
    async (_name, patch) => {
      const tx = buildTx({
        target: proposedRow(),
        profile: { ...activeProfile, ...patch },
      });
      const { service } = setup(providerActor, tx, proposedSnap());

      await expect(
        respond(service, 'provider-user-1', { accept: true }),
      ).rejects.toMatchObject({
        message:
          'This date no longer works for the provider. XPro will propose a new one.',
      });
    },
  );

  it('re-checks overlap on the second confirmation', async () => {
    const tx = buildTx({
      target: proposedRow(),
      overlap: { startAt: START, endAt: END },
    });
    const { service } = setup(providerActor, tx, proposedSnap());

    await expect(
      respond(service, 'provider-user-1', { accept: true }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('starts T12 reminders only when still ahead, and T13 two working hours after the start (D-30)', async () => {
    // 20 hours before the start: the 24 h reminder is already past.
    const now = new Date(START.getTime() - 20 * 3_600_000);
    const tx = buildTx({ target: proposedRow() });
    const kit = systemCommandKit({
      tx,
      now,
      snap: {
        status: 'ready_to_schedule',
        ownerId: 'customer-1',
        currentProviderUserId: 'provider-user-1',
        providerStanding: 'active',
        providerCard: { businessName: null, firstName: 'Alex' },
        ...proposedSnap(),
      } as never,
    });
    const service = new SchedulesService(
      {} as never,
      { resolve: jest.fn().mockResolvedValue(providerActor) } as never,
      kit.runner,
    );

    await respond(service, 'provider-user-1', { accept: true });

    expect(kit.effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T12.reminder2h',
      'T13.noShowCheck',
    ]);
    expect(kit.effects.timerStarts[1].dueAt).toEqual(
      new Date('2026-10-26T11:00:00.000Z'),
    );
  });

  it('puts T13 across the weekend using working hours (D-30)', async () => {
    // Friday 30 Oct 2026, 17:00 WAT start.
    const friday = new Date('2026-10-30T16:00:00.000Z');
    const tx = buildTx({
      target: proposedRow({
        startAt: friday,
        endAt: new Date(friday.getTime() + 3_600_000),
      }),
      profile: {
        ...activeProfile,
        workingHours: { fri: { start: '08:00', end: '18:00' } },
      },
    });
    const { service, effects } = setup(providerActor, tx, proposedSnap());

    await respond(service, 'provider-user-1', { accept: true });

    const t13 = effects.timerStarts.find(
      ({ kind }) => kind === 'T13.noShowCheck',
    );
    expect(t13?.dueAt).toEqual(new Date('2026-11-02T08:00:00.000Z'));
  });

  it('refuses a decline without a note before touching the database (D-32)', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service } = setup(providerActor, tx, proposedSnap());

    await expect(
      respond(service, 'provider-user-1', { accept: false, note: ' ' }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Explain your requested schedule change.',
    });
    expect(tx.schedule.findFirst).not.toHaveBeenCalled();
  });

  it('reports a spent response before the missing decline note (D-32)', async () => {
    const tx = buildTx({ target: proposedRow() });
    const { service } = setup(customerActor, tx, proposedSnap());

    await expect(
      respond(service, 'customer-1', { accept: false }),
    ).rejects.toMatchObject({
      message: 'Your response has already been recorded.',
    });
  });
});

describe('SchedulesService.requestChange', () => {
  const ask = (service: SchedulesService, userId: string) =>
    service.requestChange(
      { id: userId } as never,
      'XPR-00042',
      'schedule-1',
      { note: 'Need another day' },
      undefined,
      '/url',
    );
  const confirmedSnap = {
    status: 'scheduled',
    currentSchedule: {
      status: 'confirmed',
      customer: 'accepted',
      provider: 'accepted',
      startAt: START,
      endAt: END,
      changeRequests: [],
    },
  };

  it('writes the plan §D.2 shape', async () => {
    const tx = buildTx({
      confirmed: { id: 'schedule-1', startAt: START, changeRequests: [] },
    });
    const { service } = setup(customerActor, tx, confirmedSnap);

    await ask(service, 'customer-1');

    expect(tx.schedule.update).toHaveBeenCalledWith({
      where: { id: 'schedule-1' },
      data: {
        changeRequests: [
          {
            by: 'customer',
            note: 'Need another day',
            at: NOW.toISOString(),
            handledAt: null,
          },
        ],
      },
    });
  });

  it('opens a schedule_change item for staff when a party asks to reschedule', async () => {
    const tx = buildTx({
      confirmed: { id: 'schedule-1', startAt: START, changeRequests: [] },
    });
    const { service, effects } = setup(customerActor, tx, confirmedSnap);

    await ask(service, 'customer-1');

    expect(effects.approvalOpens).toEqual([
      { kind: 'schedule_change', itemId: 'schedule-1' },
    ]);
  });

  it('refuses a second open request from the same party, old shape included', async () => {
    const tx = buildTx({
      confirmed: {
        id: 'schedule-1',
        startAt: START,
        changeRequests: [{ party: 'customer', note: 'x', createdAt: 't' }],
      },
    });
    const { service } = setup(customerActor, tx, confirmedSnap);

    await expect(ask(service, 'customer-1')).rejects.toMatchObject({
      message: 'Your date change request is already with XPro.',
    });
  });

  it('lets the other party ask, and a party ask again after its request was handled', async () => {
    const tx = buildTx({
      confirmed: {
        id: 'schedule-1',
        startAt: START,
        changeRequests: [
          { by: 'customer', note: 'x', at: 't', handledAt: 'done' },
          { by: 'provider', note: 'y', at: 't', handledAt: null },
        ],
      },
    });
    const { service } = setup(customerActor, tx, confirmedSnap);

    await ask(service, 'customer-1');

    expect(tx.schedule.update).toHaveBeenCalledWith({
      where: { id: 'schedule-1' },
      data: { changeRequests: expect.arrayContaining([]) as unknown },
    });
    const [args] = tx.schedule.update.mock.calls[0] as [
      { data: { changeRequests: unknown[] } },
    ];
    expect(args.data.changeRequests).toHaveLength(3);
  });
});
