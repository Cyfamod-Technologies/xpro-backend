import type { Prisma, PrismaClient } from '@prisma/client';
import type { Seed, SeedSummary } from './seed.types';

export type SeedOptions = {
  /** Run only the seed with this name. */
  only?: string;
  /** Apply even when the ledger already holds this version. */
  force?: boolean;
  /** Run the seed, report what it would change, and roll everything back. */
  dryRun?: boolean;
};

export type SeedReport = {
  name: string;
  version: number;
  status: 'applied' | 'skipped' | 'dry-run';
  summary?: SeedSummary;
  recordedVersion?: number;
};

class DryRunRollback extends Error {
  constructor(readonly summary: SeedSummary) {
    super('dry run');
  }
}

const TRANSACTION = { timeout: 120_000, maxWait: 15_000 };

export function parseSeedArgs(argv: readonly string[]): SeedOptions {
  const options: SeedOptions = {};
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--only=')) options.only = arg.slice(7);
    else
      throw new Error(
        `Unknown option "${arg}". Use --only=<name>, --force or --dry-run.`,
      );
  }
  return options;
}

async function runOne(
  prisma: PrismaClient,
  seed: Seed,
  options: SeedOptions,
  log: (message: string) => void,
): Promise<SeedReport> {
  const base = { name: seed.name, version: seed.version };
  try {
    return await prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<SeedReport> => {
        // Two deploys starting together run the seed one after the other, and the second sees the ledger row.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`seed:${seed.name}`}, 0))`;
        const recorded = await tx.dataSeed.findUnique({
          where: { name: seed.name },
        });
        if (recorded && recorded.version >= seed.version && !options.force) {
          if (
            seed.checksum &&
            recorded.checksum &&
            recorded.checksum !== seed.checksum
          )
            log(
              `[seed] ${seed.name}: the data changed but the version is still ${seed.version}; bump the version to apply it.`,
            );
          return {
            ...base,
            status: 'skipped',
            recordedVersion: recorded.version,
          };
        }
        const summary = await seed.apply(tx);
        if (options.dryRun) throw new DryRunRollback(summary);
        const version = Math.max(seed.version, recorded?.version ?? 0);
        await tx.dataSeed.upsert({
          where: { name: seed.name },
          create: { name: seed.name, version, checksum: seed.checksum },
          update: { version, checksum: seed.checksum, appliedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            entityType: 'seed',
            entityId: seed.name,
            action: 'seed.applied',
            metadata: {
              version: seed.version,
              forced: options.force ?? false,
              summary,
            },
          },
        });
        return { ...base, status: 'applied', summary };
      },
      TRANSACTION,
    );
  } catch (error) {
    if (error instanceof DryRunRollback)
      return { ...base, status: 'dry-run', summary: error.summary };
    throw error;
  }
}

/** Runs the seeds in order, each in its own transaction with its ledger write. Stops at the first failure. */
export async function runSeeds(
  prisma: PrismaClient,
  seeds: readonly Seed[],
  options: SeedOptions = {},
  log: (message: string) => void = (message) => console.log(message),
): Promise<SeedReport[]> {
  const chosen = options.only
    ? seeds.filter(({ name }) => name === options.only)
    : seeds;
  if (!chosen.length)
    throw new Error(
      `No seed called "${options.only}". Available: ${seeds.map(({ name }) => name).join(', ')}.`,
    );
  const reports: SeedReport[] = [];
  for (const seed of chosen) {
    const report = await runOne(prisma, seed, options, log);
    reports.push(report);
    const detail =
      report.status === 'skipped'
        ? `already at version ${report.recordedVersion}`
        : JSON.stringify(report.summary);
    log(`[seed] ${seed.name}: ${report.status} (v${seed.version}) ${detail}`);
  }
  return reports;
}
