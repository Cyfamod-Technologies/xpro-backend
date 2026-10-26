import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

describe('finance foreign keys', () => {
  let requestId: string;

  beforeEach(async () => {
    const request = await prisma.serviceRequest.create({
      data: {
        ownerId: randomUUID(),
        customerName: 'FK customer',
        title: 'Finance FK test',
        service: 'Design',
        cityId: randomUUID(),
        districtId: randomUUID(),
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for finance foreign keys.',
      },
    });
    requestId = request.id;
  });

  afterEach(async () => {
    await prisma.refund.deleteMany({ where: { requestId } });
    await prisma.payment.deleteMany({ where: { requestId } });
    await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a refund whose payment_id does not exist', async () => {
    await expect(
      prisma.refund.create({
        data: {
          paymentId: randomUUID(),
          requestId,
          amount: 1000n,
          reason: 'FK test',
          requestedBy: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rejects a payment whose request_id does not exist', async () => {
    await expect(
      prisma.payment.create({
        data: {
          requestId: randomUUID(),
          quoteId: randomUUID(),
          quoteVersion: 1,
          amount: 1000n,
          method: 'offline',
          status: 'recorded',
          reference: `ref-${randomUUID()}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('restricts deleting a request that has a payment', async () => {
    await prisma.payment.create({
      data: {
        requestId,
        quoteId: randomUUID(),
        quoteVersion: 1,
        amount: 1000n,
        method: 'offline',
        status: 'recorded',
        reference: `ref-${randomUUID()}`,
      },
    });
    await expect(
      prisma.serviceRequest.delete({ where: { id: requestId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
