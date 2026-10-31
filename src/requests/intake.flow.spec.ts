import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import { locationStub } from '../platform/locations/locations.testkit';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { contactFieldsChanged, IntakeService } from './intake.service';
import { RequestCommandRunner } from './command-runner';
import {
  catalogRows,
  seededCatalog,
} from '../platform/catalog/catalog.testkit';

describe('request intake command flows', () => {
  it('replays a completed create with the same idempotency key and response', async () => {
    const body = { id: 'XPR-00042', version: 1 } as never;
    let stored: { status: number; body: unknown } | null = null;
    const idempotency = {
      lookup: jest.fn(() => Promise.resolve(stored)),
      store: jest.fn(
        (
          _actorId: string,
          _key: string,
          _hash: string,
          status: number,
          responseBody: unknown,
        ) => {
          stored = { status, body: responseBody };
          return Promise.resolve();
        },
      ),
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const loaded = {
      row: { id: 'request-42', ownerId: 'customer-1' },
      snapshot: {},
    };
    const loader = { load: jest.fn().mockResolvedValue(loaded) };
    const runner = new RequestCommandRunner(
      prisma as never,
      loader,
      { snapshot: jest.fn().mockResolvedValue([]) } as never,
      idempotency as never,
      {} as never,
      { kick: jest.fn() } as never,
      { kick: jest.fn() } as never,
      {} as never,
    );
    (
      runner as unknown as { project: (...args: unknown[]) => unknown }
    ).project = jest.fn(() => body);

    const actor: ActorContext = {
      userId: 'customer-1',
      kind: 'customer',
      displayName: 'Customer',
      platformRoles: ['customer'],
      accountActive: true,
    };
    const createRow = jest.fn(() => Promise.resolve('request-42'));
    const command = jest.fn(() => Promise.resolve({ status: 201 }));
    const options = {
      actor,
      idempotencyKey: 'create-key',
      idempotencyHash: 'payload-hash',
    };

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
      serviceId: null,
      answers: [],
      locationId: 'district-1',
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
      requestEdit: { create: jest.fn() },
      catalogService: {
        findMany: jest.fn().mockResolvedValue(catalogRows(seededCatalog())),
      },
      location: locationStub(),
    };
    const timers = { stop: jest.fn() };
    const approvals = { open: jest.fn(), close: jest.fn() };
    const notify = jest.fn();
    const context = {
      tx,
      snap: {
        id: 'request-42',
        number: 'XPR-00042',
        ownerId,
        locationName: 'Example District',
        currentAssignment: null,
      },
      now: new Date('2026-10-23T10:00:00.000Z'),
      timers,
      approvals,
      notify,
      audit: jest.fn(),
      enqueueCascade: jest.fn(),
    };
    const runner = {
      run: jest.fn(
        async (
          _options: unknown,
          command: (commandContext: unknown) => Promise<unknown>,
        ) => {
          await command(context);
          return { status: 200, body: {} as never, etag: 'W/"4"' };
        },
      ),
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
    );
    const user: RequestUser = {
      id: ownerId,
      email: 'customer@example.test',
      role: 'user',
      surfaces: [],
    };

    await service.update(user, 'XPR-00042', {}, 3, '/requests/XPR-00042');

    expect(tx.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request-42' },
        data: { intakeState: 'pending' },
      }),
    );
    expect(tx.requestEdit.create).not.toHaveBeenCalled();
    expect(timers.stop).toHaveBeenCalledWith([
      TimerKinds.T6Reminder48h,
      TimerKinds.T6Staff5d,
      TimerKinds.T6FinalWarning,
      TimerKinds.T6AutoCancel,
    ]);
    expect(approvals.close).toHaveBeenCalledWith(
      'clarification_overdue',
      'request-42',
      'clarification_answered',
    );
    // 02 §6.11: the intake item runs again from the customer's answer.
    expect(approvals.open).toHaveBeenCalledWith('intake', 'request-42');
    expect(notify).toHaveBeenCalledWith('request.clarification_answered', {
      requestCode: 'XPR-00042',
    });
  });

  it('clarifies intake by posting a customer-channel staff message and starting all T6 deadlines', async () => {
    const now = new Date('2026-10-23T10:00:00.000Z');
    const tx = {
      requestMessage: { create: jest.fn() },
      serviceRequest: { update: jest.fn() },
    };
    const context = {
      tx,
      snap: {
        id: 'request-42',
        number: 'XPR-00042',
        status: 'submitted',
        intake: { state: 'pending' },
        ownerId: 'customer-1',
        assignments: [],
      },
      actor: {
        kind: 'staff',
        userId: 'staff-1',
        staff: { permissions: new Set(['request.clarify']) },
      },
      now,
      settings: {},
      timers: { start: jest.fn(), stop: jest.fn() },
      approvals: { open: jest.fn(), close: jest.fn() },
      notify: jest.fn(),
      audit: jest.fn(),
      enqueueCascade: jest.fn(),
    };
    const runner = {
      run: jest.fn(
        async (
          _options: unknown,
          command: (ctx: unknown) => Promise<unknown>,
        ) => {
          await command(context);
          return { status: 200, body: {} as never, etag: 'W/"2"' };
        },
      ),
    };
    const service = new IntakeService(
      {
        resolve: jest.fn().mockResolvedValue({
          userId: 'staff-1',
          kind: 'staff',
          displayName: 'XPro Team',
          platformRoles: ['staff'],
          accountActive: true,
          staff: {
            status: 'active',
            roles: ['client_relations'],
            permissions: new Set(['request.clarify']),
            canOwn: true,
            isSuperAdmin: false,
            permVersion: 1,
          },
        }),
      } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
      {} as never,
    );
    const user: RequestUser = {
      id: 'staff-1',
      email: 'staff@example.test',
      role: 'admin',
      surfaces: [],
    };

    await service.clarify(
      user,
      'XPR-00042',
      { question: 'Which room needs repair?' },
      1,
      '/requests/XPR-00042/clarify',
    );

    expect(tx.requestMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'request-42',
        channel: 'customer',
        authorId: 'staff-1',
        authorRole: 'staff',
        text: 'Which room needs repair?',
      }) as unknown,
    });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-42' },
      data: expect.objectContaining({
        intakeState: 'clarification',
        clarificationAskedAt: now,
        clarificationCount: { increment: 1 },
      }) as unknown,
    });
    expect(context.timers.stop).toHaveBeenCalledWith([
      TimerKinds.T6Reminder48h,
      TimerKinds.T6Staff5d,
      TimerKinds.T6FinalWarning,
      TimerKinds.T6AutoCancel,
    ]);
    expect(context.timers.start).toHaveBeenCalledTimes(4);
    expect(
      context.timers.start.mock.calls.map(([kind, dueAt]: [string, Date]) => [
        kind,
        dueAt.toISOString(),
      ]),
    ).toEqual([
      [TimerKinds.T6Reminder48h, '2026-10-25T10:00:00.000Z'],
      [TimerKinds.T6Staff5d, '2026-10-28T10:00:00.000Z'],
      [TimerKinds.T6FinalWarning, '2026-11-05T10:00:00.000Z'],
      [TimerKinds.T6AutoCancel, '2026-11-06T10:00:00.000Z'],
    ]);
    expect(context.approvals.open).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith(
      'request.clarification_requested',
      { requestCode: 'XPR-00042' },
    );
  });

  it('approves intake and queues auto dispatch with the current service mode', async () => {
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          contactInBrief: false,
          service: 'Construction',
          attachments: [],
        }),
        update: jest.fn(),
      },
    };
    const context = {
      tx,
      snap: {
        id: 'request-42',
        number: 'XPR-00042',
        status: 'submitted',
        intake: { state: 'pending' },
        customerStanding: 'active',
        pendingCancellation: false,
      },
      now: new Date('2026-10-23T10:00:00.000Z'),
      settings: { 'assignment.modeByService': { Construction: 'auto' } },
      timers: { stop: jest.fn() },
      approvals: { open: jest.fn(), close: jest.fn() },
      notify: jest.fn(),
      audit: jest.fn(),
      enqueueCascade: jest.fn(),
    };
    const runner = {
      run: jest.fn(
        async (
          _options: unknown,
          command: (ctx: unknown) => Promise<unknown>,
        ) => {
          await command(context);
          return { status: 200, body: {} as never, etag: 'W/"2"' };
        },
      ),
    };
    const service = new IntakeService(
      {
        resolve: jest.fn().mockResolvedValue({
          userId: 'staff-1',
          kind: 'staff',
          displayName: 'Operations',
          platformRoles: ['staff'],
          accountActive: true,
          staff: {
            status: 'active',
            roles: ['operations'],
            permissions: new Set(['request.review']),
            canOwn: true,
            isSuperAdmin: false,
            permVersion: 1,
          },
        }),
      } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
      {} as never,
    );
    const user: RequestUser = {
      id: 'staff-1',
      email: 'staff@example.test',
      role: 'admin',
      surfaces: [],
    };

    await service.review(
      user,
      'XPR-00042',
      {
        offerBrief: 'A concise brief for verified providers.',
      },
      1,
      '/requests/XPR-00042/review',
    );

    expect(tx.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          intakeState: 'approved',
          status: 'under_review',
          dispatchMode: 'auto',
          autoAttempts: 0,
        }) as unknown,
      }),
    );
    expect(context.enqueueCascade).toHaveBeenCalledWith('intake_approved');
    expect(context.notify).toHaveBeenCalledWith('request.approved', {
      requestCode: 'XPR-00042',
    });
  });
  describe('A-12/A-14/A-29 intake command effects', () => {
    const staffActor = (permissions: string[]): ActorContext => ({
      userId: 'staff-1',
      kind: 'staff',
      displayName: 'Operations',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: ['operations'],
        permissions: new Set(permissions) as never,
        canOwn: true,
        isSuperAdmin: false,
        permVersion: 1,
      },
    });
    const staffUser: RequestUser = {
      id: 'staff-1',
      email: 'staff@example.test',
      role: 'admin',
      surfaces: [],
    };

    function build(
      actor: ActorContext,
      overrides: { settings?: Record<string, unknown>; row?: object } = {},
    ) {
      const now = new Date('2026-10-23T10:00:00.000Z');
      const tx = {
        approvalDeadline: { findMany: jest.fn().mockResolvedValue([]) },
        requestMessage: { create: jest.fn() },
        serviceRequest: {
          update: jest.fn(),
          findUnique: jest.fn().mockResolvedValue({
            id: 'request-42',
            ownerId: 'customer-1',
            title: 'Repair a leaking roof',
            service: 'Construction',
            serviceId: null,
            answers: [],
            locationId: 'district-1',
            address: '12 Example Road',
            phone: '+2348031234567',
            contactMethod: 'phone',
            description: 'Repair the damaged roof above the kitchen.',
            budget: BigInt(0),
            startDate: null,
            details: { workType: 'Roof and ceiling', area: 42 },
            intakeState: 'pending',
            attachments: [],
            assignments: [],
            quotes: [],
            ...overrides.row,
          }),
        },
        cancellation: {
          create: jest.fn().mockResolvedValue({ id: 'cancellation-1' }),
        },
        catalogService: {
          findMany: jest.fn().mockResolvedValue(catalogRows(seededCatalog())),
        },
        location: locationStub(),
        requestEdit: { create: jest.fn() },
      };
      const context = {
        tx,
        snap: {
          id: 'request-42',
          number: 'XPR-00042',
          status: 'submitted',
          intake: { state: 'pending' },
          ownerId: 'customer-1',
          assignments: [],
          currentAssignment: null,
        },
        actor,
        now,
        settings: overrides.settings ?? {},
        timers: { start: jest.fn(), stop: jest.fn() },
        approvals: { open: jest.fn(), close: jest.fn() },
        notify: jest.fn(),
        audit: jest.fn(),
        enqueueCascade: jest.fn(),
      };
      const runner = {
        run: jest.fn(
          async (
            _options: unknown,
            command: (ctx: unknown) => Promise<unknown>,
          ) => {
            await command(context);
            return { status: 200, body: {} as never, etag: 'W/"2"' };
          },
        ),
      };
      const service = new IntakeService(
        { resolve: jest.fn().mockResolvedValue(actor) } as never,
        runner as never,
        { hashRequest: jest.fn().mockReturnValue('hash') } as never,
        {} as never,
      );
      return { service, context, tx, runner };
    }

    it('derives the T6 due times from the clarification settings (A-12)', async () => {
      const { service, context } = build(staffActor(['request.clarify']), {
        settings: {
          'clarification.reminderHours': 12,
          'clarification.escalateDays': 2,
          'clarification.autoCancelDays': 7,
        },
      });

      await service.clarify(
        staffUser,
        'XPR-00042',
        { question: 'Which room needs repair?' },
        1,
        '/requests/XPR-00042/clarify',
      );

      expect(
        context.timers.start.mock.calls.map(([kind, dueAt]: [string, Date]) => [
          kind,
          dueAt.toISOString(),
        ]),
      ).toEqual([
        [TimerKinds.T6Reminder48h, '2026-10-23T22:00:00.000Z'],
        [TimerKinds.T6Staff5d, '2026-10-25T10:00:00.000Z'],
        [TimerKinds.T6FinalWarning, '2026-10-29T10:00:00.000Z'],
        [TimerKinds.T6AutoCancel, '2026-10-30T10:00:00.000Z'],
      ]);
      expect(context.approvals.open).not.toHaveBeenCalled();
    });

    it('closes the intake items when staff reject (A-14)', async () => {
      const { service, context } = build(staffActor(['request.review']));

      await service.reject(
        staffUser,
        'XPR-00042',
        { reason: 'Outside our service area' },
        1,
        '/requests/XPR-00042/reject',
      );

      expect(
        context.approvals.close.mock.calls.map(
          ([kind, itemId, reason]: [string, string, string]) => [
            kind,
            itemId,
            reason,
          ],
        ),
      ).toEqual([
        ['intake', 'request-42', 'rejected'],
        ['clarification_overdue', 'request-42', 'rejected'],
        ['unclaimed', 'request-42', 'rejected'],
      ]);
    });

    it('opens needs_assignment when intake is approved in manual mode, and nothing in auto mode (A-20)', async () => {
      const review = (mode: 'auto' | 'manual') => {
        const kit = build(staffActor(['request.review']), {
          settings: { 'assignment.modeByService': { Construction: mode } },
        });
        return kit.service
          .review(
            staffUser,
            'XPR-00042',
            { offerBrief: 'A concise brief for verified providers.' },
            1,
            '/requests/XPR-00042/review',
          )
          .then(() => kit.context);
      };

      const manual = await review('manual');
      expect(manual.approvals.open).toHaveBeenCalledWith(
        'needs_assignment',
        'request-42',
      );
      expect(manual.enqueueCascade).not.toHaveBeenCalled();

      const auto = await review('auto');
      expect(auto.approvals.open).not.toHaveBeenCalled();
      expect(auto.enqueueCascade).toHaveBeenCalledWith('intake_approved');
    });

    it('opens the intake and unclaimed items when a request is submitted (A-20)', async () => {
      const context = {
        snap: { id: 'request-42', number: 'XPR-00042' },
        tx: {},
        now: new Date('2026-10-23T10:00:00.000Z'),
        approvals: { open: jest.fn(), close: jest.fn() },
        notify: jest.fn(),
        audit: jest.fn(),
      };
      const runner = {
        create: jest.fn(
          async (
            _options: unknown,
            _createRow: unknown,
            command: (ctx: unknown) => Promise<unknown>,
          ) => {
            await command(context);
            return { status: 201, body: {} as never, etag: 'W/"1"' };
          },
        ),
      };
      const service = new IntakeService(
        {
          resolve: jest.fn().mockResolvedValue({
            userId: 'customer-1',
            kind: 'customer',
            displayName: 'Customer',
            platformRoles: ['customer'],
            accountActive: true,
          }),
        } as never,
        runner as never,
        { hashRequest: jest.fn().mockReturnValue('hash') } as never,
        {} as never,
      );

      await service.create(
        { ...staffUser, id: 'customer-1' },
        {} as never,
        'key-1',
        '/requests',
      );

      expect(context.approvals.open.mock.calls).toEqual([
        ['intake', 'request-42'],
        ['unclaimed', 'request-42'],
      ]);
    });

    it('closes the intake items on a free cancel, also for a provider who owns the request (A-14, A-15)', async () => {
      const dualRole: ActorContext = {
        userId: 'customer-1',
        kind: 'provider',
        displayName: 'Pat',
        platformRoles: ['provider', 'customer'],
        accountActive: true,
      };
      const { service, context, tx } = build(dualRole);

      await service.freeCancel(
        { ...staffUser, id: 'customer-1' },
        'XPR-00042',
        { note: 'I no longer need this' },
        1,
        '/requests/XPR-00042/cancel',
      );

      expect(tx.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: 'request-42' },
        data: { status: 'cancelled' },
      });
      expect(
        context.approvals.close.mock.calls.map(
          ([kind, , reason]: [string, string, string]) => [kind, reason],
        ),
      ).toEqual([
        ['intake', 'cancelled'],
        ['clarification_overdue', 'cancelled'],
        ['unclaimed', 'cancelled'],
      ]);
    });

    it('lets staff without view.customer_contact resend unchanged contact fields (A-29)', async () => {
      const { service, runner, tx } = build(staffActor(['request.review']));

      await expect(
        service.update(
          staffUser,
          'XPR-00042',
          {
            phone: '0803 123 4567',
            address: ' 12 Example Road ',
            contactMethod: 'phone',
            note: 'Customer asked for a title change',
            title: 'Repair the kitchen roof',
          },
          1,
          '/requests/XPR-00042',
        ),
      ).resolves.toBeDefined();
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(tx.serviceRequest.update).toHaveBeenCalled();
    });

    it('still refuses staff without view.customer_contact when a contact value changes (A-29)', async () => {
      const { service } = build(staffActor(['request.review']));

      await expect(
        service.update(
          staffUser,
          'XPR-00042',
          {
            phone: '08031239999',
            note: 'Customer gave a new number',
          },
          1,
          '/requests/XPR-00042',
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: {
          code: 'FORBIDDEN',
          message: 'Your staff role does not allow this action.',
        },
      });
    });
  });

  describe('contactFieldsChanged', () => {
    const row = {
      phone: '+2348031234567',
      address: '12 Example Road',
      contactMethod: 'phone' as const,
    };

    it('ignores absent and unchanged values', () => {
      expect(contactFieldsChanged(row, {})).toBe(false);
      expect(
        contactFieldsChanged(row, {
          phone: '08031234567',
          address: '12 Example Road',
          contactMethod: 'phone',
        }),
      ).toBe(false);
    });

    it.each([
      [{ phone: '08031239999' }],
      [{ address: '14 Other Road' }],
      [{ contactMethod: 'both' as const }],
    ])('reports a changed value %j', (change) => {
      expect(contactFieldsChanged(row, change)).toBe(true);
    });
  });
});
