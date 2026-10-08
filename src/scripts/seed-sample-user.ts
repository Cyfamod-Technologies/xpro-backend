/**
 * Creates or updates an ordinary, already-verified user for local development,
 * so you can log in without going through signup + email verification.
 *
 * Usage:
 *   npm run seed:sample-user -- --email demo@example.com --password "Str0ng!Pass"
 *
 * All flags are optional — defaults are read from environment variables:
 *   SAMPLE_USER_EMAIL, SAMPLE_USER_PASSWORD,
 *   SAMPLE_USER_FIRST_NAME, SAMPLE_USER_LAST_NAME
 */

import { AccountStatus, AppRole, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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

async function main() {
  const args = parseArgs();

  const email = (
    args['email'] ||
    process.env.SAMPLE_USER_EMAIL ||
    'demo@example.com'
  )
    .trim()
    .toLowerCase();

  const password = args['password'] || process.env.SAMPLE_USER_PASSWORD;

  if (!password) {
    console.error(
      'A password is required. Pass --password or set SAMPLE_USER_PASSWORD.',
    );
    process.exit(1);
  }

  const firstName =
    args['firstName'] || process.env.SAMPLE_USER_FIRST_NAME || 'Alex';
  const lastName =
    args['lastName'] || process.env.SAMPLE_USER_LAST_NAME || 'Demo';

  const passwordHash = await bcrypt.hash(password, 12);

  const shared = {
    passwordHash,
    firstName,
    lastName,
    role: AppRole.user,
    status: AccountStatus.active,
    emailVerifiedAt: new Date(),
    onboardingCompleted: true,
  };

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, ...shared },
    update: shared,
  });

  console.log('\nSample user upserted successfully.');
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
  .finally(() => void prisma.$disconnect());
