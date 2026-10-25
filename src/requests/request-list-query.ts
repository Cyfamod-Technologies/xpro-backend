import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { AppError } from '../platform/errors/app-error';
import type { RequestSort } from './dto/request-list-query.dto';

export const OWNER_FILTER_MESSAGE =
  'Owner must be all, mine, unclaimed or a staff member id.';

/**
 * Maps the staff `owner` filter to a `staffOwnerId` condition (04 §11.2, 02 §11.3):
 * `all` adds none, `mine` the actor, `unclaimed` null, anything else a staff user id.
 */
export function ownerFilter(
  owner: string | undefined,
  actorId: string,
): Prisma.ServiceRequestWhereInput | null {
  if (owner === undefined || owner === 'all') return null;
  if (owner === 'mine') return { staffOwnerId: actorId };
  if (owner === 'unclaimed') return { staffOwnerId: null };
  if (!isUUID(owner)) {
    throw new AppError(422, 'VALIDATION_ERROR', OWNER_FILTER_MESSAGE);
  }
  return { staffOwnerId: owner };
}

/** Every order ends on `id` so pages never repeat or skip rows. */
export function listOrderBy(
  sort: RequestSort = 'createdAt:desc',
): Prisma.ServiceRequestOrderByWithRelationInput[] {
  switch (sort) {
    case 'createdAt:asc':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'updatedAt:desc':
      return [{ updatedAt: 'desc' }, { id: 'desc' }];
    case 'id:asc':
      return [{ id: 'asc' }];
    case 'createdAt:desc':
      return [{ createdAt: 'desc' }, { id: 'desc' }];
  }
}
