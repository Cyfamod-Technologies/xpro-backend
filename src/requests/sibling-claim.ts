import { Prisma, type RequestStatus } from '@prisma/client';
import type { ApprovalsHooks } from './approvals.hooks';
import { formatRequestId } from './domain/statuses';

const TERMINAL_STATUSES: RequestStatus[] = ['closed', 'cancelled', 'rejected'];

export type SiblingClaimInput = {
  groupId: string;
  /** The request whose claim triggered this one; its XPR id goes in the audit note. */
  trigger: { id: string; number: number };
  staffId: string;
  actorType: string;
  now: Date;
  /** `request.claimed` for a claim, `request.auto_claimed` for an auto-claim. */
  action: 'request.claimed' | 'request.auto_claimed';
  /** The command that triggered the claim. */
  command: string;
};

/**
 * 02 §6.5 bundles: after a request in a group is claimed, claims the other open,
 * unowned requests of the group for the same staff member in the same transaction.
 * The lock query uses SKIP LOCKED and its rows are the only candidates, in ascending
 * id. A sibling another transaction holds is left unclaimed rather than waited on,
 * so two staff claiming different members of one bundle cannot deadlock; staff can
 * claim that sibling normally. A sibling that gained an owner or ended is skipped.
 * A claim sends no notification.
 */
export async function claimGroupSiblings(
  tx: Prisma.TransactionClient,
  hooks: Pick<ApprovalsHooks, 'close'>,
  input: SiblingClaimInput,
): Promise<string[]> {
  const { groupId, trigger, staffId, now, action } = input;
  const siblings = await tx.$queryRaw<
    Array<{ id: string; ownershipVersion: number }>
  >(
    Prisma.sql`SELECT id, ownership_version AS "ownershipVersion" FROM service_requests WHERE group_id = ${groupId} AND id <> ${trigger.id} AND staff_owner_id IS NULL ORDER BY id FOR UPDATE SKIP LOCKED`,
  );
  const claimed: string[] = [];
  for (const sibling of siblings) {
    const result = await tx.serviceRequest.updateMany({
      where: {
        id: sibling.id,
        staffOwnerId: null,
        ownershipVersion: sibling.ownershipVersion,
        status: { notIn: TERMINAL_STATUSES },
      },
      data: {
        staffOwnerId: staffId,
        claimedAt: now,
        unclaimedSince: null,
        ownershipVersion: { increment: 1 },
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    if (result.count !== 1) continue;
    await hooks.close(
      tx,
      'unclaimed',
      sibling.id,
      now,
      action === 'request.claimed' ? 'claimed' : 'auto_claimed',
    );
    const before = { staffOwnerId: null };
    const after = { staffOwnerId: staffId };
    await tx.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: staffId,
        entityType: 'service_request',
        entityId: sibling.id,
        action,
        metadata: {
          requestId: sibling.id,
          command: input.command,
          note: `with ${formatRequestId(trigger.number)} in the same project`,
          ...(action === 'request.claimed'
            ? { changes: { before, after } }
            : { before, after }),
        },
      },
    });
    claimed.push(sibling.id);
  }
  return claimed;
}
