import { Prisma } from '@prisma/client';
import { AppError } from '../platform/errors/app-error';
import {
  evaluateOpenRequestLimit,
  openRequestAllowance,
} from './domain/open-request-limit';
import { TERMINAL } from './domain/statuses';

type Db = Pick<Prisma.TransactionClient, 'user' | 'serviceRequest'>;
type Settings = Readonly<Record<string, unknown>>;

/** What staff see for a request's owner (04 §11.2): the override, the limit in force and the requests counted against it. */
export type CustomerRequestLimit = {
  userId: string;
  override: number | null;
  effective: number;
  open: number;
};

/** Requests that are not closed, cancelled or rejected (`cancelling` is open). */
export function countOpenRequests(db: Db, ownerId: string): Promise<number> {
  return db.serviceRequest.count({
    where: { ownerId, status: { notIn: [...TERMINAL] } },
  });
}

export async function loadCustomerRequestLimit(
  db: Db,
  userId: string,
  settings: Settings,
): Promise<CustomerRequestLimit> {
  const [user, open] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { openRequestLimit: true },
    }),
    countOpenRequests(db, userId),
  ]);
  const override = user?.openRequestLimit ?? null;
  return {
    userId,
    override,
    effective: openRequestAllowance({ open, override, settings }).limit,
    open,
  };
}

/**
 * Refuses a submission that would create `requested` requests beyond the
 * owner's limit (04 §6.2). Call it inside the creation transaction after all
 * intake validation and before anything is inserted: the per-owner lock keeps
 * two submissions made at once from both passing the count.
 */
export async function enforceOpenRequestLimit(
  tx: Prisma.TransactionClient,
  ownerId: string,
  settings: Settings,
  requested: number,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`open-request-limit:${ownerId}`}, 0))`,
  );
  const { effective: limit, open } = await loadCustomerRequestLimit(
    tx,
    ownerId,
    settings,
  );
  const result = evaluateOpenRequestLimit({ open, limit, requested });
  if (!('code' in result)) return;
  throw new AppError(422, result.code, result.message, { ...result.details });
}
