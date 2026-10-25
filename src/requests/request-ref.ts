import type { Prisma } from '@prisma/client';
import { parseRequestId } from './domain/statuses';

export type RequestRefDb = Pick<Prisma.TransactionClient, 'serviceRequest'>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves `XPR-00042` or a request uuid to `service_requests.id`.
 * Returns null for a malformed or unknown reference.
 */
export async function resolveRequestId(
  db: RequestRefDb,
  ref: string,
): Promise<string | null> {
  const sequence = parseRequestId(ref);
  if (sequence !== null) {
    const row = await db.serviceRequest.findUnique({
      where: { number: sequence },
      select: { id: true },
    });
    return row?.id ?? null;
  }
  if (!UUID.test(ref)) return null;
  const row = await db.serviceRequest.findUnique({
    where: { id: ref },
    select: { id: true },
  });
  return row?.id ?? null;
}
