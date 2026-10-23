import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import { TimerKinds } from '../platform/timers/timer-kinds';
import type { RequestUpdateDto } from './dto/request-intake.dto';
import { IntakeService } from './intake.service';
import { RequestCommandRunner } from './command-runner';
import type { RequestClarifyDto, RequestReviewDto } from './dto/request-intake.dto';

describe('request intake command flows', () => {
  it('replays a completed create with the same idempotency key and response', async () => {
    const body = { id: 'XPR-00042', version: 1 } as never;
    let stored: { status: number; body: unknown } | null = null;
    const idempotency = {
      lookup: jest.fn(async () => stored),
      store: jest.fn(async (_actorId: string, _key: string, _hash: string, status: number, responseBody: unknown) => {
        stored = { status, body: responseBody };
      }),
    };
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)),
    };
    const loaded = { row: { id: 'request-42', ownerId: 'customer-1' }, snapshot: {} };
    const loader = { load: jest.fn().mockResolvedValue(loaded) };
    const runner = new RequestCommandRunner(
      prisma as never,
      loader as never,
      { snapshot: jest.fn().mockResolvedValue([]) } as never,
      idempotency as never,
      {} as never,
      { kick: jest.fn() } as never,
      { kick: jest.fn() } as never,
    );
    (runner as unknown as { project: (...args: unknown[]) => unknown }).project = jest.fn(() => body);

    const actor: ActorContext = {
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    };
    const createRow = jest.fn(async () => 'request-42');
    const command = jest.fn(async () => ({ status: 201 }));
    const options = { actor, idempotencyKey: 'create-key', idempotencyHash: 'payload-hash' };

    const first = await runner.create(options, createRow, command as never);
    const replay = await runner.create(options, createRow, command as never);

    expect(first).toEqual(replay);
    expect(replay.body.id).toBe('XPR-00042');
    expect(createRow).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(1);
    expect(idempotency.store).toHaveBeenCalledTimes(1);
  });

  it('resets clarification when the customer submits an unchanged answer', async () => {
    const ownerId = 'customer-1';
    const row = {
      id: 'request-42',
      number: 42,
      ownerId,
      version: 3,
      title: 'Repair a leaking roof',
      service: 'Construction',
      cityId: 'city-1',
      districtId: 'district-1',
      address: '12 Example Road',
      phone: '+2348031234567',
      contactMethod: 'phone',
      description: 'Repair the damaged roof above the kitchen.',
      budget: BigInt(0),
      startDate: null,
      details: { workType: 'Roof and ceiling', area: 42 },
      status: 'submitted',
      intakeState: 'clarification',
      contactInBrief: false,
      possibleDuplicateOf: null,
      dispatchMode: 'auto',
      autoAttempts: 0,
      unclaimedSince: new Date('2026-10-20T00:00:00.000Z'),
      needsAssignmentReason: null,
      assignments: [],
      quotes: [],
      attachments: [],
    };
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      location: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'city-1', kind: 'city', parentId: null, active: true },
          { id: 'district-1', kind: 'district', parentId: 'city-1', active: true },
        ]),
      },
    };
    const timers = { stop: jest.fn() };
    const notify = jest.fn();
    const context = {
      tx,
      snap: {
        id: 'request-42',
        number: 'XPR-00042',
        ownerId,
        districtName: 'Example District',
        currentAssignment: null,
      },
      now: new Date('2026-10-23T10:00:00.000Z'),
      timers,
      notify,
      audit: jest.fn(),
      enqueueCascade: jest.fn(),
    };
    const runner = {
      run: jest.fn(async (_options: unknown, command: (commandContext: unknown) => Promise<unknown>) => {
        await command(context);
        return { status: 200, body: {} as never, etag: 'W/"4"' };
      }),
    };
    const actors = {
      resolve: jest.fn().mockResolvedValue({
        userId: ownerId,
        kind: 'customer',
        displayName: 'Customer',
        platformRoles: ['customer'],
        accountActive: true,
      }),
    };
    const service = new IntakeService(
      actors as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('payload-hash') } as never,
      {} as never,
      {} as never,
    );
    const user: RequestUser = {
      id: ownerId,
      email: 'customer@example.test',
      role: 'user',
      surfaces: [],
    };

    await service.update(user, 'XPR-00042', {} as RequestUpdateDto, 3, '/requests/XPR-00042');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request-42' },
      data: { intakeState: 'pending' },
    }));
    expect(timers.stop).toHaveBeenCalledWith([
      TimerKinds.T6Reminder48h,
      TimerKinds.T6Staff5d,
      TimerKinds.T6FinalWarning,
      TimerKinds.T6AutoCancel,
    ]);
    expect(notify).toHaveBeenCalledWith('request.clarification_answered', { requestCode: 'XPR-00042' });
  });

  it('clarifies intake by posting a customer-channel staff message and starting all T6 deadlines', async () => {
    const now = new Date('2026-10-23T10:00:00.000Z');
    const tx = {
      requestMessage: { create: jest.fn() },
      serviceRequest: { update: jest.fn() },
    };
    const context = {
      tx,
      snap: { id: 'request-42', number: 'XPR-00042', status: 'submitted', intake: { state: 'pending' }, ownerId: 'customer-1', assignments: [] },
      actor: { kind: 'staff', userId: 'staff-1', staff: { permissions: new Set(['request.clarify']) } },
      now,
      settings: {},
      timers: { start: jest.fn(), stop: jest.fn() },
      notify: jest.fn(), audit: jest.fn(), enqueueCascade: jest.fn(),
    };
    const runner = { run: jest.fn(async (_options: unknown, command: (ctx: unknown) => Promise<unknown>) => {
      await command(context);
      return { status: 200, body: {} as never, etag: 'W/"2"' };
    }) };
    const service = new IntakeService(
      { resolve: jest.fn().mockResolvedValue({
        userId: 'staff-1', kind: 'staff', displayName: 'XPro Team', platformRoles: ['staff'], accountActive: true,
        staff: { status: 'active', roles: ['client_relations'], permissions: new Set(['request.clarify']), canOwn: true, isSuperAdmin: false, permVersion: 1 },
      }) } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
      {} as never,
      {} as never,
    );
    const user: RequestUser = { id: 'staff-1', email: 'staff@example.test', role: 'admin', surfaces: [] };

    await service.clarify(user, 'XPR-00042', { question: 'Which room needs repair?' } as RequestClarifyDto, 1, '/requests/XPR-00042/clarify');

    expect(tx.requestMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      requestId: 'request-42', channel: 'customer', authorId: 'staff-1', authorRole: 'staff', text: 'Which room needs repair?',
    }) });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({ where: { id: 'request-42' }, data: expect.objectContaining({
      intakeState: 'clarification', clarificationAskedAt: now, clarificationCount: { increment: 1 },
    }) });
    expect(context.timers.stop).toHaveBeenCalledWith([
      TimerKinds.T6Reminder48h, TimerKinds.T6Staff5d, TimerKinds.T6FinalWarning, TimerKinds.T6AutoCancel,
    ]);
    expect(context.timers.start).toHaveBeenCalledTimes(4);
    expect(context.notify).toHaveBeenCalledWith('request.clarification_requested', { requestCode: 'XPR-00042' });
  });

  it('approves intake and queues auto dispatch with the current service mode', async () => {
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({ contactInBrief: false, service: 'Construction', attachments: [] }),
        update: jest.fn(),
      },
    };
    const context = {
      tx,
      snap: { id: 'request-42', number: 'XPR-00042', status: 'submitted', intake: { state: 'pending' }, customerStanding: 'active', pendingCancellation: false },
      now: new Date('2026-10-23T10:00:00.000Z'), settings: { 'assignment.modeByService': { Construction: 'auto' } },
      timers: { stop: jest.fn() }, notify: jest.fn(), audit: jest.fn(), enqueueCascade: jest.fn(),
    };
    const runner = { run: jest.fn(async (_options: unknown, command: (ctx: unknown) => Promise<unknown>) => {
      await command(context);
      return { status: 200, body: {} as never, etag: 'W/"2"' };
    }) };
    const service = new IntakeService(
      { resolve: jest.fn().mockResolvedValue({
        userId: 'staff-1', kind: 'staff', displayName: 'Operations', platformRoles: ['staff'], accountActive: true,
        staff: { status: 'active', roles: ['operations'], permissions: new Set(['request.review']), canOwn: true, isSuperAdmin: false, permVersion: 1 },
      }) } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
      {} as never,
      {} as never,
    );
    const user: RequestUser = { id: 'staff-1', email: 'staff@example.test', role: 'admin', surfaces: [] };

    await service.review(user, 'XPR-00042', { offerBrief: 'A concise brief for verified providers.' } as RequestReviewDto, 1, '/requests/XPR-00042/review');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      intakeState: 'approved', status: 'under_review', dispatchMode: 'auto', autoAttempts: 0,
    }) }));
    expect(context.enqueueCascade).toHaveBeenCalledWith('intake_approved');
    expect(context.notify).toHaveBeenCalledWith('request.approved', { requestCode: 'XPR-00042' });
  });
});
