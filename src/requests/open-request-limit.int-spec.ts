import { PrismaClient } from '@prisma/client';
import { createUser, deleteTestUsers } from '../../test/integration/users';
import type { AppError } from '../platform/errors/app-error';
import { enforceOpenRequestLimit } from './open-request-limit';

const prisma = new PrismaClient();
const settings = { 'request.maxOpenPerCustomer': 1 };

describe('open-request limit (integration)', () => {
  let ownerId: string;

  const row = (title: string) => ({
    ownerId,
    customerName: 'Integration customer',
    title,
    service: 'Construction',
    cityId: 'city-int',
    districtId: 'district-int',
    address: '1 Test Street',
    phone: '+2348012345678',
    description: 'Integration test request for the open-request limit.',
  });

  /** The check and the create of POST /requests, with a pause between them to widen the race window. */
  const submit = (title: string) =>
    prisma.$transaction(async (tx) => {
      await enforceOpenRequestLimit(tx, ownerId, settings, 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return tx.serviceRequest.create({ data: row(title) });
    });

  beforeAll(async () => {
    ownerId = (await createUser(prisma)).id;
  });

  afterEach(async () => {
    await prisma.serviceRequest.deleteMany({ where: { ownerId } });
    await prisma.user.update({
      where: { id: ownerId },
      data: { openRequestLimit: null },
    });
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  it('lets only one of two concurrent creates through at a limit of 1', async () => {
    const outcomes = await Promise.allSettled([
      submit('Concurrent one'),
      submit('Concurrent two'),
    ]);

    const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0].reason as AppError;
    expect(error.code).toBe('OPEN_REQUEST_LIMIT');
    expect(error.getStatus()).toBe(422);
    expect(error.details).toEqual({ limit: 1, open: 1, remaining: 0 });
    expect(await prisma.serviceRequest.count({ where: { ownerId } })).toBe(1);
  });

  it('does not count closed, cancelled or rejected requests', async () => {
    for (const status of ['closed', 'cancelled', 'rejected'] as const)
      await prisma.serviceRequest.create({
        data: { ...row(`Finished ${status}`), status },
      });
    await expect(submit('Fits')).resolves.toBeDefined();
  });

  it("applies the customer's override over the setting", async () => {
    await prisma.user.update({
      where: { id: ownerId },
      data: { openRequestLimit: 2 },
    });
    await prisma.serviceRequest.create({ data: row('Already open') });
    await expect(submit('Second')).resolves.toBeDefined();
    await expect(submit('Third')).rejects.toMatchObject({
      code: 'OPEN_REQUEST_LIMIT',
      details: { limit: 2, open: 2, remaining: 0 },
    });
  });

  it('keeps users.open_request_limit between 1 and 50, or null (CHECK constraint)', async () => {
    for (const value of [1, 50, null])
      await expect(
        prisma.user.update({
          where: { id: ownerId },
          data: { openRequestLimit: value },
        }),
      ).resolves.toMatchObject({ openRequestLimit: value });
    for (const value of [0, 51, -1])
      await expect(
        prisma.user.update({
          where: { id: ownerId },
          data: { openRequestLimit: value },
        }),
      ).rejects.toThrow(/users_open_request_limit_range/);
  });
});
