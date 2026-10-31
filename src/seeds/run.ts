/**
 * Applies the data seeds to the current database. Safe to run on every deploy:
 * a seed already recorded in `data_seeds` at its version is skipped.
 *
 * Usage:
 *   npm run seed                     run every seed that is not yet applied
 *   npm run seed -- --only=catalog   run one seed
 *   npm run seed -- --force          re-apply a seed that is already recorded
 *   npm run seed -- --dry-run        report what would change, write nothing
 *
 * Run it after `prisma migrate deploy`.
 */
import { PrismaClient } from '@prisma/client';
import { SEEDS } from './registry';
import { parseSeedArgs, runSeeds } from './runner';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeeds(prisma, SEEDS, parseSeedArgs(process.argv.slice(2)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
