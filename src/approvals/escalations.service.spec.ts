import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { systemCommandKit } from '../requests/system-command.testkit';
import { RaiseEscalationDto, ResolveEscalationDto } from './escalations.dto';
import { EscalationsService } from './escalations.service';

const REQUEST_ID = '3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f';

function setup() {
  const raisedAt = new Date('2026-10-24T10:00:00Z');
  const prisma = {
    serviceRequest: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: string; number?: number } }) =>
          Promise.resolve(
            where.number === 42 || where.id === REQUEST_ID
              ? { id: REQUEST_ID }
              : null,
          ),
      ),
    },
    requestEscalation: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'e-1',
          target: 'operations',
          source: 'staff',
          note: 'Check this',
          raisedBy: 'staff-1',
          raisedAt,
          resolvedBy: null,
          resolvedAt: null,
          resolution: null,
        },
      ]),
    },
  };
  const actors = {
    resolve: jest.fn().mockResolvedValue({
      userId: 'staff-1',
      kind: 'staff',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(['request.escalation.resolve']),
        isSuperAdmin: false,
      },
    }),
  };
  const service = new EscalationsService(
    prisma as never,
    actors as never,
    {} as never,
  );
  return { service, prisma };
}

describe('EscalationsService.list reference lookup', () => {
  const user = { id: 'staff-1' } as never;

  it('accepts an XPR reference', async () => {
    const { service, prisma } = setup();
    const rows = await service.list(user, 'XPR-00042');
    expect(rows).toHaveLength(1);
    expect(prisma.requestEscalation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requestId: REQUEST_ID } }),
    );
  });

  it('accepts a uuid', async () => {
    const { service } = setup();
    await expect(service.list(user, REQUEST_ID)).resolves.toHaveLength(1);
  });

  it.each(['XPR-00099', 'not-a-ref'])('returns 404 for %s', async (ref) => {
    const { service, prisma } = setup();
    await expect(service.list(user, ref)).rejects.toMatchObject({
      status: 404,
      message: 'This request is no longer available to your account.',
    });
    expect(prisma.requestEscalation.findMany).not.toHaveBeenCalled();
  });
});

describe('EscalationsService.resolveForDispute (D-28)', () => {
  function setupDispute(open: Array<{ id: string }>) {
    const tx = {
      requestEscalation: {
        findMany: jest.fn().mockResolvedValue(open),
        update: jest.fn(),
      },
    };
    const closes: unknown[] = [];
    const audit: unknown[] = [];
    const now = new Date('2026-10-26T10:00:00Z');
    const ctx = {
      tx,
      snap: { id: REQUEST_ID },
      now,
      audit: (action: string, data: unknown) => audit.push({ action, data }),
      approvals: {
        open: jest.fn(),
        close: (...args: unknown[]) => closes.push(args),
      },
    };
    const service = new EscalationsService(
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, tx, closes, audit, ctx, now };
  }

  it('resolves the open super_admin escalation with the decision note and closes its queue item', async () => {
    const { service, tx, closes, audit, ctx, now } = setupDispute([
      { id: 'e-1' },
    ]);

    await expect(
      service.resolveForDispute(ctx as never, 'admin-1', '  Final call.  '),
    ).resolves.toBe(1);

    expect(tx.requestEscalation.findMany).toHaveBeenCalledWith({
      where: { requestId: REQUEST_ID, target: 'super_admin', resolvedAt: null },
      select: { id: true, raisedBy: true },
    });
    expect(tx.requestEscalation.update).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      data: {
        resolvedBy: 'admin-1',
        resolvedAt: now,
        resolution: 'Final call.',
      },
    });
    expect(closes).toEqual([['escalation', 'e-1', 'resolved']]);
    expect(audit[0]).toMatchObject({ action: 'request.escalation_resolved' });
  });

  it('does nothing when no super_admin escalation is open', async () => {
    const { service, tx, closes, ctx } = setupDispute([]);

    await expect(
      service.resolveForDispute(ctx as never, 'admin-1', 'Final call.'),
    ).resolves.toBe(0);

    expect(tx.requestEscalation.update).not.toHaveBeenCalled();
    expect(closes).toEqual([]);
  });
});

function staffActor(
  permissions: string[],
  isSuperAdmin = false,
  userId = 'staff-1',
) {
  return {
    userId,
    kind: 'staff',
    displayName: 'Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: [],
      permissions: new Set(permissions),
      canOwn: false,
      isSuperAdmin,
      permVersion: 1,
    },
  };
}

function commandSetup(options: {
  actor: ReturnType<typeof staffActor>;
  open?: Array<{
    id: string;
    to: 'operations' | 'super_admin';
    raisedBy: string | null;
  }>;
  row?: Record<string, unknown> | null;
}) {
  const tx = {
    requestEscalation: {
      findFirst: jest.fn((args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id
            ? options.row === undefined
              ? { id: 'e-1', raisedBy: 'staff-9', target: 'operations' }
              : options.row
            : null,
        ),
      ),
      create: jest.fn().mockResolvedValue({ id: 'e-new' }),
      update: jest.fn(),
    },
    serviceRequest: {
      findUnique: jest.fn().mockResolvedValue({ title: 'Roof repair' }),
    },
  };
  const kit = systemCommandKit({
    tx,
    snap: { status: 'in_progress', openEscalations: options.open ?? [] },
  });
  const service = new EscalationsService(
    {} as never,
    { resolve: jest.fn().mockResolvedValue(options.actor) } as never,
    kit.runner,
  );
  return { service, tx, ...kit };
}

const raise = (
  service: EscalationsService,
  dto: { to: 'operations' | 'super_admin'; note: string },
) =>
  service.raise(
    { id: 'staff-1' } as never,
    'XPR-00042',
    dto,
    undefined,
    '/url',
  );
const resolveCall = (service: EscalationsService, note = 'Sorted it out.') =>
  service.resolve(
    { id: 'staff-1' } as never,
    'XPR-00042',
    'e-1',
    { note },
    undefined,
    '/url',
  );

describe('EscalationsService.raise (02 §6.10)', () => {
  const actor = () => staffActor(['request.escalate']);

  it('opens an escalation to operations, its queue item and the notice for the resolve holders', async () => {
    const { service, tx, effects, ctx } = commandSetup({ actor: actor() });

    await raise(service, {
      to: 'operations',
      note: '  Customer is unreachable.  ',
    });

    expect(tx.requestEscalation.create).toHaveBeenCalledWith({
      data: {
        requestId: ctx.snap.id,
        target: 'operations',
        source: 'staff',
        note: 'Customer is unreachable.',
        raisedBy: 'staff-1',
        raisedAt: ctx.now,
      },
    });
    expect(effects.approvalOpens).toEqual([
      { kind: 'escalation', itemId: 'e-new' },
    ]);
    expect(effects.notify).toEqual([
      {
        event: 'escalation.raised',
        params: {
          requestCode: 'XPR-00042',
          title: 'Roof repair',
          note: 'Customer is unreachable.',
        },
      },
    ]);
    expect(effects.audit[0]).toMatchObject({
      action: 'request.escalated',
      data: {
        resourceId: 'e-new',
        changes: { to: 'operations', source: 'staff' },
      },
    });
  });

  it('tells every super admin when the escalation goes to super_admin', async () => {
    const { service, effects } = commandSetup({ actor: actor() });

    await raise(service, { to: 'super_admin', note: 'Needs a decision.' });

    expect(effects.notify.map(({ event }) => event)).toEqual([
      'escalation.raised_super_admin',
    ]);
  });

  it('refuses a second open escalation to the same target with the 02 message', async () => {
    const { service, tx } = commandSetup({
      actor: actor(),
      open: [{ id: 'e-1', to: 'operations', raisedBy: 'staff-9' }],
    });

    await expect(
      raise(service, { to: 'operations', note: 'Again, please.' }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This request already has an open escalation to operations.',
    });
    expect(tx.requestEscalation.create).not.toHaveBeenCalled();
  });

  it('refuses a short note with the 02 message', async () => {
    const { service } = commandSetup({ actor: actor() });

    await expect(
      raise(service, { to: 'operations', note: 'no' }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Add a note explaining the escalation.',
    });
  });
});

describe('EscalationsService.resolve (02 §6.10)', () => {
  const resolver = (isSuperAdmin = false) =>
    staffActor(['request.escalation.resolve'], isSuperAdmin);
  const open = (to: 'operations' | 'super_admin', raisedBy: string | null) => [
    { id: 'e-1', to, raisedBy },
  ];

  it('resolves, closes the queue item and tells the raiser with the note', async () => {
    const { service, tx, effects, ctx } = commandSetup({
      actor: resolver(),
      open: open('operations', 'staff-9'),
    });

    await resolveCall(service, '  Customer reached.  ');

    expect(tx.requestEscalation.update).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      data: {
        resolvedBy: 'staff-1',
        resolvedAt: ctx.now,
        resolution: 'Customer reached.',
      },
    });
    expect(effects.approvalCloses).toEqual([
      { kind: 'escalation', itemId: 'e-1', reason: 'resolved' },
    ]);
    expect(effects.notify).toEqual([
      {
        event: 'escalation.resolved',
        params: {
          recipientId: 'staff-9',
          requestCode: 'XPR-00042',
          note: 'Customer reached.',
        },
      },
    ]);
    expect(effects.audit[0]).toMatchObject({
      action: 'request.escalation_resolved',
    });
  });

  it('tells nobody when a system escalation has no raiser', async () => {
    const { service, effects } = commandSetup({
      actor: resolver(),
      open: open('operations', null),
      row: { id: 'e-1', raisedBy: null, target: 'operations' },
    });

    await resolveCall(service);

    expect(effects.notify).toEqual([]);
  });

  it('is a 403 for the raiser with the 02 message, and for a super_admin escalation without the role', async () => {
    const own = commandSetup({
      actor: resolver(),
      open: open('operations', 'staff-1'),
    });
    await expect(resolveCall(own.service)).rejects.toMatchObject({
      status: 403,
      message: 'Someone else must resolve an escalation you raised.',
    });

    const top = commandSetup({
      actor: resolver(),
      open: open('super_admin', 'staff-9'),
    });
    await expect(resolveCall(top.service)).rejects.toMatchObject({
      status: 403,
      message: 'Only a super admin can resolve this escalation.',
    });
    expect(top.tx.requestEscalation.update).not.toHaveBeenCalled();
  });

  it('lets a super admin resolve a super_admin escalation, even one they raised', async () => {
    const { service, tx } = commandSetup({
      actor: resolver(true),
      open: open('super_admin', 'staff-1'),
      row: { id: 'e-1', raisedBy: 'staff-1', target: 'super_admin' },
    });

    await resolveCall(service);

    expect(tx.requestEscalation.update).toHaveBeenCalled();
  });

  it('is a 409 when the escalation is no longer open, and needs a note', async () => {
    const gone = commandSetup({ actor: resolver(), open: [] });
    await expect(resolveCall(gone.service)).rejects.toMatchObject({
      status: 409,
      message: 'This escalation is no longer open.',
    });

    const short = commandSetup({
      actor: resolver(),
      open: open('operations', 'staff-9'),
    });
    await expect(resolveCall(short.service, 'ok')).rejects.toMatchObject({
      status: 422,
      message: 'Add a resolution note.',
    });
  });
});

describe('EscalationsService.list projection and access', () => {
  it('returns { to, state, resolutionNote } and lets any active staff member read', async () => {
    const raisedAt = new Date('2026-10-24T10:00:00Z');
    const resolvedAt = new Date('2026-10-25T10:00:00Z');
    const prisma = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({ id: REQUEST_ID }),
      },
      requestEscalation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e-2',
            requestId: REQUEST_ID,
            target: 'super_admin',
            source: 'system',
            note: 'Issue disputed',
            raisedBy: null,
            raisedAt,
            resolvedBy: 'admin-1',
            resolvedAt,
            resolution: 'Final call.',
          },
          {
            id: 'e-1',
            requestId: REQUEST_ID,
            target: 'operations',
            source: 'staff',
            note: 'Check this',
            raisedBy: 'staff-1',
            raisedAt,
            resolvedBy: null,
            resolvedAt: null,
            resolution: null,
          },
        ]),
      },
    };
    const service = new EscalationsService(
      prisma as never,
      {
        resolve: jest.fn().mockResolvedValue(staffActor(['message.internal'])),
      } as never,
      {} as never,
    );

    const rows = await service.list({ id: 'staff-1' } as never, REQUEST_ID);

    expect(rows[0]).toEqual({
      id: 'e-2',
      requestId: REQUEST_ID,
      to: 'super_admin',
      source: 'system',
      note: 'Issue disputed',
      raisedBy: null,
      raisedAt: raisedAt.toISOString(),
      state: 'resolved',
      resolvedBy: 'admin-1',
      resolvedAt: resolvedAt.toISOString(),
      resolutionNote: 'Final call.',
    });
    expect(rows[1]).toMatchObject({
      to: 'operations',
      state: 'open',
      resolutionNote: null,
    });
  });

  it('refuses a caller who is not active staff', async () => {
    const service = new EscalationsService(
      {} as never,
      {
        resolve: jest.fn().mockResolvedValue({ platformRoles: ['customer'] }),
      } as never,
      {} as never,
    );
    await expect(
      service.list({ id: 'c' } as never, REQUEST_ID),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('escalation DTOs (FD-2: body { to, note })', () => {
  const check = (dto: object) =>
    validate(plainToInstance(RaiseEscalationDto, dto), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts { to, note } for both targets', async () => {
    expect(await check({ to: 'operations', note: 'Look at this.' })).toEqual(
      [],
    );
    expect(await check({ to: 'super_admin', note: 'Look at this.' })).toEqual(
      [],
    );
  });

  it('rejects the old `target` field and an unknown target', async () => {
    expect(
      (await check({ target: 'operations', note: 'Look at this.' })).length,
    ).toBeGreaterThan(0);
    expect(
      (await check({ to: 'finance', note: 'Look at this.' })).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the 5-character minimum to the guards so the spec messages reach the client', async () => {
    expect(await check({ to: 'operations', note: 'no' })).toEqual([]);
    expect(
      await validate(plainToInstance(ResolveEscalationDto, { note: 'no' })),
    ).toEqual([]);
  });
});
