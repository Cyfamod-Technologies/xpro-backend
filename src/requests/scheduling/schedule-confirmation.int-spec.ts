import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isOverlapViolation, mapOverlapViolation } from './overlap-violation';

const prisma = new PrismaClient();

describe('schedule confirmation race (04 §6.13, D-04)', () => {
  const providerId = randomUUID();
  const requestIds: string[] = [];

  const makeRequest = async () => {
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: randomUUID(),
        customerName: 'Integration customer',
        title: 'Schedule race',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for schedule confirmation.',
      },
    });
    requestIds.push(request.id);
    return request.id;
  };

  const makeProposal = async (requestId: string, startAt: Date, endAt: Date) =>
    prisma.schedule.create({
      data: {
        requestId,
        assignmentId: randomUUID(),
        providerId,
        quoteId: randomUUID(),
        startAt,
        endAt,
        status: 'proposed',
        customer: 'accepted',
        provider: 'accepted',
        proposedBy: randomUUID(),
        proposedAt: new Date(),
      },
    });

  const confirm = (scheduleId: string) =>
    prisma.$transaction((tx) =>
      tx.schedule.update({
        where: { id: scheduleId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      }),
    );

  afterEach(async () => {
    await prisma.serviceRequest.deleteMany({
      where: { id: { in: requestIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('lets exactly one of two concurrent confirmations for overlapping slots win, and maps the loser to the 409', async () => {
    const first = await makeProposal(
      await makeRequest(),
      new Date('2027-03-01T09:00:00.000Z'),
      new Date('2027-03-01T11:00:00.000Z'),
    );
    const second = await makeProposal(
      await makeRequest(),
      new Date('2027-03-01T10:00:00.000Z'),
      new Date('2027-03-01T12:00:00.000Z'),
    );

    const results = await Promise.allSettled([
      confirm(first.id),
      confirm(second.id),
    ]);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isOverlapViolation(rejected[0].reason)).toBe(true);
    expect(mapOverlapViolation(rejected[0].reason)).toMatchObject({
      status: 409,
      message:
        'This date no longer works for the provider. XPro will propose a new one.',
    });
    const confirmed = await prisma.schedule.count({
      where: { providerId, status: 'confirmed' },
    });
    expect(confirmed).toBe(1);
  });

  it('allows back-to-back confirmations because the range excludes its end', async () => {
    const first = await makeProposal(
      await makeRequest(),
      new Date('2027-03-03T09:00:00.000Z'),
      new Date('2027-03-03T10:00:00.000Z'),
    );
    const second = await makeProposal(
      await makeRequest(),
      new Date('2027-03-03T10:00:00.000Z'),
      new Date('2027-03-03T11:00:00.000Z'),
    );

    await expect(
      Promise.all([confirm(first.id), confirm(second.id)]),
    ).resolves.toHaveLength(2);
  });

  it('lets a reschedule be confirmed once the old row is superseded in the same transaction', async () => {
    const requestId = await makeRequest();
    const old = await makeProposal(
      requestId,
      new Date('2027-03-04T09:00:00.000Z'),
      new Date('2027-03-04T11:00:00.000Z'),
    );
    await confirm(old.id);
    const moved = await makeProposal(
      requestId,
      new Date('2027-03-04T10:00:00.000Z'),
      new Date('2027-03-04T12:00:00.000Z'),
    );

    const refused = await confirm(moved.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isOverlapViolation(refused)).toBe(true);

    await prisma.$transaction(async (tx) => {
      await tx.schedule.update({
        where: { id: old.id },
        data: { status: 'superseded' },
      });
      await tx.schedule.update({
        where: { id: moved.id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
    });
    const rows = await prisma.schedule.findMany({
      where: { requestId },
      orderBy: { startAt: 'asc' },
    });
    expect(rows.map((row) => row.status)).toEqual(['superseded', 'confirmed']);
  });
});
