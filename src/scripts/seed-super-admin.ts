/**
 * Creates or updates a super_admin user (platform operator — no organization).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/seed-super-admin.ts \
 *     --email admin@example.com \
 *     --password "Str0ng!Pass" \
 *     --firstName Admin \
 *     --lastName User
 *
 * All flags are optional — defaults are read from environment variables:
 *   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_FIRST_NAME, SUPER_ADMIN_LAST_NAME
 */

import {
  AccountStatus,
  AppRole,
  PlatformRole,
  PrismaClient,
  RoleAddedVia,
  StaffRole,
  StaffStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as readline from 'readline';

const prisma = new PrismaClient();

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      let input = '';
      process.stdin.on('data', (chunk) => {
        const char = chunk.toString();
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '') {
          process.exit();
        } else {
          input += char;
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  const args = parseArgs();

  const email = (
    args['email'] ||
    process.env.SUPER_ADMIN_EMAIL ||
    (await prompt('Email: '))
  )
    .trim()
    .toLowerCase();

  const password =
    args['password'] ||
    process.env.SUPER_ADMIN_PASSWORD ||
    (await prompt('Password: ', true));

  if (!email || !password) {
    console.error('Email and password are required.');
    process.exit(1);
  }

  const firstName =
    args['firstName'] || process.env.SUPER_ADMIN_FIRST_NAME || 'Super';

  const lastName =
    args['lastName'] || process.env.SUPER_ADMIN_LAST_NAME || 'Admin';

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      firstName,
      lastName,
      role: AppRole.super_admin,
      status: AccountStatus.active,
      emailVerifiedAt: new Date(),
    },
    update: {
      passwordHash,
      firstName,
      lastName,
      role: AppRole.super_admin,
      status: AccountStatus.active,
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.$transaction([
    prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role: PlatformRole.staff } },
      create: {
        userId: user.id,
        role: PlatformRole.staff,
        addedVia: RoleAddedVia.invite,
      },
      update: {},
    }),
    prisma.staffMember.upsert({
      where: { userId: user.id },
      create: { userId: user.id, status: StaffStatus.active },
      update: { status: StaffStatus.active },
    }),
    prisma.staffMemberRole.upsert({
      where: {
        staffUserId_role: { staffUserId: user.id, role: StaffRole.super_admin },
      },
      create: { staffUserId: user.id, role: StaffRole.super_admin },
      update: {},
    }),
  ]);

  console.log(`\nSuper-admin upserted successfully.`);
  console.log(`  ID:     ${user.id}`);
  console.log(`  Email:  ${user.email}`);
  console.log(`  Name:   ${user.firstName} ${user.lastName}`);
  console.log(`  Role:   ${user.role}`);
  console.log(`  Status: ${user.status}`);
}

main()
  .catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
