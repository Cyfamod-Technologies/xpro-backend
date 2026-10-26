import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RequestSnapshotLoader } from './snapshot.loader';
import { resolveRequestId } from './request-ref';

const prisma = new PrismaClient();

describe('request row locks and references', () => {
  let request: { id: string; number: number };

  beforeEach(async () => {
    request = await prisma.serviceRequest.create({
      data: {
        ownerId: randomUUID(),
        customerName: 'Integration customer',
        title: 'Row lock test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for row locking.',
      },
    });
  });

  afterEach(async () => {
    await prisma.serviceRequest.deleteMany({ where: { id: request.id } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('locks service_requests.id (text) with a plain text comparison', async () => {
    const locked = await prisma.$transaction((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${request.id} FOR UPDATE`,
      ),
    );
    expect(locked).toEqual([{ id: request.id }]);
  });

  it('returns no row when locking an unknown id', async () => {
    const locked = await prisma.$transaction((tx) =>
      tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${randomUUID()} FOR UPDATE`,
      ),
    );
    expect(locked).toEqual([]);
  });

  it('loads and locks a request by uuid and by XPR number', async () => {
    const loader = new RequestSnapshotLoader();
    const xpr = `XPR-${String(request.number).padStart(5, '0')}`;
    for (const ref of [request.id, xpr]) {
      const loaded = await prisma.$transaction((tx) =>
        loader.load(tx, ref, { forUpdate: true }),
      );
      expect(loaded?.row.id).toBe(request.id);
    }
  });

  it('resolves XPR and uuid references to the same id', async () => {
    const xpr = `XPR-${String(request.number).padStart(5, '0')}`;
    await expect(resolveRequestId(prisma, xpr)).resolves.toBe(request.id);
    await expect(resolveRequestId(prisma, request.id)).resolves.toBe(
      request.id,
    );
    await expect(resolveRequestId(prisma, randomUUID())).resolves.toBeNull();
  });
});
