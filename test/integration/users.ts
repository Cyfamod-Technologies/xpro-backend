import type { PrismaClient, StaffRole } from '@prisma/client';
import { randomUUID } from 'crypto';

const RUN = randomUUID().slice(0, 8);
let counter = 0;

export async function createUser(
  prisma: PrismaClient,
  options: { status?: 'active' | 'suspended' } = {},
) {
  counter += 1;
  return prisma.user.create({
    data: {
      email: `int-${RUN}-${counter}@example.com`,
      status: options.status ?? 'active',
      firstName: 'Test',
      lastName: `User${counter}`,
    },
  });
}

export async function createStaff(
  prisma: PrismaClient,
  roles: StaffRole[],
  options: { status?: 'active' | 'suspended' } = {},
) {
  const user = await createUser(prisma);
  await prisma.userRole.create({
    data: { userId: user.id, role: 'staff', addedVia: 'invite' },
  });
  await prisma.staffMember.create({
    data: {
      userId: user.id,
      status: options.status ?? 'active',
      roles: { create: roles.map((role) => ({ role })) },
    },
  });
  return user;
}

export async function deleteTestUsers(prisma: PrismaClient) {
  await prisma.user.deleteMany({
    where: { email: { startsWith: `int-${RUN}-` } },
  });
}
