import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

describe('request schema constraints', () => {
  let requestId: string;

  beforeEach(async () => {
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: randomUUID(),
        customerName: 'Integration customer',
        title: 'Schema constraint test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for database constraints.',
      },
    });
    requestId = request.id;
  });

  afterEach(async () => {
    if (requestId) {
      await prisma.serviceRequest.delete({ where: { id: requestId } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects two current assignments for one request', async () => {
    const offeredAt = new Date('2026-10-23T10:00:00.000Z');
    const shared = {
      requestId,
      source: 'auto' as const,
      offeredAt,
      expiresAt: new Date('2026-10-24T10:00:00.000Z'),
    };

    await prisma.assignment.create({
      data: {
        ...shared,
        providerId: randomUUID(),
        providerUserId: randomUUID(),
      },
    });

    await expect(
      prisma.assignment.create({
        data: {
          ...shared,
          providerId: randomUUID(),
          providerUserId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects overlapping confirmed schedules for one provider', async () => {
    const providerId = randomUUID();
    const shared = {
      requestId,
      providerId,
      quoteId: randomUUID(),
      assignmentId: randomUUID(),
      startAt: new Date('2026-10-24T10:00:00.000Z'),
      endAt: new Date('2026-10-24T12:00:00.000Z'),
      proposedBy: randomUUID(),
      proposedAt: new Date('2026-10-23T10:00:00.000Z'),
      status: 'confirmed' as const,
    };

    await prisma.schedule.create({ data: shared });

    await expect(
      prisma.schedule.create({
        data: {
          ...shared,
          id: randomUUID(),
          startAt: new Date('2026-10-24T11:00:00.000Z'),
          endAt: new Date('2026-10-24T13:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
  });

  it('allows overlapping proposed schedules for one provider', async () => {
    const providerId = randomUUID();
    const shared = {
      requestId,
      providerId,
      quoteId: randomUUID(),
      assignmentId: randomUUID(),
      startAt: new Date('2026-10-24T10:00:00.000Z'),
      endAt: new Date('2026-10-24T12:00:00.000Z'),
      proposedBy: randomUUID(),
      proposedAt: new Date('2026-10-23T10:00:00.000Z'),
      status: 'proposed' as const,
    };

    await prisma.schedule.create({ data: shared });
    await prisma.schedule.create({
      data: {
        ...shared,
        id: randomUUID(),
        startAt: new Date('2026-10-24T11:00:00.000Z'),
        endAt: new Date('2026-10-24T13:00:00.000Z'),
      },
    });

    await expect(
      prisma.schedule.count({ where: { requestId, providerId } }),
    ).resolves.toBe(2);
  });
});
