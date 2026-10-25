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
      select: { id: true },
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
    expect(audit[0]).toMatchObject({ action: 'Request escalation resolved' });
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
