import type { Prisma } from '@prisma/client';

/** Counts of what a seed changed, by name. Zero everywhere means it was already applied. */
export type SeedSummary = Record<string, number>;

export interface Seed {
  /** The ledger key in `data_seeds`. Never rename it. */
  name: string;
  /** Bump when the data changes on purpose: a deploy applies a seed only when this is above the recorded version. */
  version: number;
  /** Hash of the seed's data. Recorded in the ledger so a change without a version bump is noticed. */
  checksum?: string;
  /** Runs inside the runner's transaction together with the ledger write. */
  apply(tx: Prisma.TransactionClient): Promise<SeedSummary>;
}
