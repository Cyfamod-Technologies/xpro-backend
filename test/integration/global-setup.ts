import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { SEEDS } from '../../src/seeds/registry';
import { runSeeds } from '../../src/seeds/runner';
import { resolveTestDatabaseUrl } from './test-database';

export default async function globalSetup() {
  const url = resolveTestDatabaseUrl();
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  // The migrations carry the first catalog only; the seeds bring it to the current one.
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await runSeeds(prisma, SEEDS);
  } finally {
    await prisma.$disconnect();
  }
}
