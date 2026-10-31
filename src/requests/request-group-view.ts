import type { Prisma } from '@prisma/client';
import { deriveStage } from './domain/stage';
import { formatRequestId } from './domain/statuses';
import type {
  RequestGroupSummary,
  RequestSiblingView,
} from './dto/request-detail.dto';
import {
  LIST_ROW_SELECT,
  type ListDb,
  type RequestListLoader,
} from './request-list.loader';

export type RequestGroupView = {
  group: RequestGroupSummary | null;
  siblings: RequestSiblingView[];
};

export type RequestGroupViewDb = ListDb &
  Pick<Prisma.TransactionClient, 'requestGroup'>;

const SIBLING_SELECT = {
  ...LIST_ROW_SELECT,
  servicePath: true,
} satisfies Prisma.ServiceRequestSelect;

export const UNGROUPED: RequestGroupView = { group: null, siblings: [] };

function leafName(servicePath: unknown, fallback: string): string {
  if (!Array.isArray(servicePath)) return fallback;
  const leaf = servicePath[servicePath.length - 1] as
    { name?: unknown } | null | undefined;
  return typeof leaf?.name === 'string' && leaf.name ? leaf.name : fallback;
}

/**
 * The `group` and `siblings` of a request detail (04 §4.1a). Customers and staff
 * only: the caller never calls this for a provider. One query reads the group and
 * its other requests in `groupPosition` order, and one batched pass derives their
 * stages. A customer only reads their own requests of the group.
 */
export async function loadGroupView(
  db: RequestGroupViewDb,
  listLoader: Pick<RequestListLoader, 'attachSnapshots'>,
  request: { id: string; groupId: string | null; ownerId: string },
  reader: 'customer' | 'staff',
  now: Date,
): Promise<RequestGroupView> {
  if (!request.groupId) return UNGROUPED;
  const group = await db.requestGroup.findUnique({
    where: { id: request.groupId },
    select: {
      id: true,
      ref: true,
      title: true,
      requests: {
        where: {
          id: { not: request.id },
          ...(reader === 'customer' ? { ownerId: request.ownerId } : {}),
        },
        orderBy: [{ groupPosition: 'asc' }, { id: 'asc' }],
        select: SIBLING_SELECT,
      },
    },
  });
  if (!group) return UNGROUPED;
  const loaded = await listLoader.attachSnapshots(db, group.requests);
  return {
    group: { id: group.id, ref: group.ref, title: group.title },
    siblings: loaded.map(({ row, snapshot }, index) => ({
      id: formatRequestId(row.number),
      title: row.title,
      serviceName: leafName(group.requests[index].servicePath, row.service),
      status: row.status,
      stage: deriveStage(snapshot, now),
    })),
  };
}
