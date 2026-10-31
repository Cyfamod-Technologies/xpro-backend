import type { Prisma } from '@prisma/client';
import { formatGroupRef, parseGroupRef } from './domain/request-group';

export type RequestGroupRefDb = Pick<Prisma.TransactionClient, 'requestGroup'>;

export type RequestGroupRow = {
  id: string;
  ref: string;
  title: string;
  ownerId: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SELECT = {
  id: true,
  ref: true,
  title: true,
  ownerId: true,
} satisfies Prisma.RequestGroupSelect;

/**
 * Resolves `XPG-00042` or a group uuid to the `request_groups` row.
 * Returns null for a malformed or unknown reference.
 */
export async function resolveRequestGroup(
  db: RequestGroupRefDb,
  ref: string,
): Promise<RequestGroupRow | null> {
  const sequence = parseGroupRef(ref);
  if (sequence !== null)
    return db.requestGroup.findUnique({
      where: { ref: formatGroupRef(sequence) },
      select: SELECT,
    });
  if (!UUID.test(ref)) return null;
  return db.requestGroup.findUnique({ where: { id: ref }, select: SELECT });
}
