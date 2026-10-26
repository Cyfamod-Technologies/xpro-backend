import { ProgressService } from './progress.service';

const REQUEST_ID = '3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f';
const gone = 'This request is no longer available to your account.';

function setup() {
  const prisma = {
    serviceRequest: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: string; number?: number } }) =>
          Promise.resolve(
            where.number === 42 || where.id === REQUEST_ID
              ? { id: REQUEST_ID, ownerId: 'customer-1' }
              : null,
          ),
      ),
    },
    progressUpdate: { findMany: jest.fn().mockResolvedValue([]) },
    upload: { findMany: jest.fn().mockResolvedValue([]) },
    assignment: { findFirst: jest.fn() },
  };
  const actors = {
    resolve: jest.fn().mockResolvedValue({
      userId: 'customer-1',
      kind: 'customer',
      platformRoles: ['customer'],
      accountActive: true,
    }),
  };
  const service = new ProgressService(
    prisma as never,
    actors as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, actors };
}

describe('ProgressService.list reference lookup', () => {
  const user = { id: 'customer-1' } as never;

  it('accepts an XPR reference', async () => {
    const { service, prisma } = setup();
    await expect(service.list(user, 'XPR-00042')).resolves.toEqual([]);
    expect(prisma.progressUpdate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: REQUEST_ID, state: 'approved' },
      }),
    );
  });

  it('accepts a uuid', async () => {
    const { service, prisma } = setup();
    await expect(service.list(user, REQUEST_ID)).resolves.toEqual([]);
    expect(prisma.progressUpdate.findMany).toHaveBeenCalled();
  });

  it.each(['XPR-00099', 'not-a-ref', '9f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f'])(
    'returns 404 for %s',
    async (ref) => {
      const { service, prisma } = setup();
      await expect(service.list(user, ref)).rejects.toMatchObject({
        status: 404,
        message: gone,
      });
      expect(prisma.progressUpdate.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('ProgressService.list review text', () => {
  const rows = [
    {
      id: 'u1',
      kind: 'progress',
      target: 'in_progress',
      note: 'Tiling done',
      state: 'approved',
      reviewNote: 'Looks good, keep photos coming.',
      createdAt: new Date('2026-10-25T10:00:00.000Z'),
    },
  ];
  const listFor = async (kind: 'customer' | 'staff' | 'provider') => {
    const { service, prisma, actors } = setup();
    prisma.progressUpdate.findMany.mockResolvedValue(rows);
    prisma.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    actors.resolve.mockResolvedValue({
      userId: 'customer-1',
      kind,
      platformRoles: [kind],
      accountActive: true,
      staff: { status: 'active', permissions: new Set(['progress.review']) },
    });
    return service.list({ id: 'customer-1' } as never, 'XPR-00042');
  };

  it('never returns reviewNote to the customer (D-37)', async () => {
    const [item] = await listFor('customer');
    expect(item).not.toHaveProperty('reviewNote');
  });

  it.each(['provider', 'staff'] as const)(
    'returns reviewNote to the %s',
    async (kind) => {
      const [item] = await listFor(kind);
      expect(item).toMatchObject({
        reviewNote: 'Looks good, keep photos coming.',
      });
    },
  );
});
