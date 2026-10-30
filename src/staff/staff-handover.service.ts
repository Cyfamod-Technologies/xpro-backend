import { Injectable } from '@nestjs/common';
import { Prisma, StaffStatus } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppError } from '../platform/errors/app-error';
import { ApprovalsHooks } from '../requests/approvals.hooks';
import { formatRequestId, isOpen } from '../requests/domain/statuses';
import type { OwnedRequestsDto } from './dto/staff.dto';
import { canOwnRequests } from './staff-permissions';

export const QUEUE = 'queue';

export type OwnedRequestRow = {
  id: string;
  number: number;
  title: string;
  status: Prisma.ServiceRequestGetPayload<object>['status'];
  ownershipVersion: number;
};

export type HandoverMove = {
  request: OwnedRequestRow;
  /** A staff user id, or null for the unclaimed queue. */
  to: string | null;
};

export type MovedRequest = {
  requestId: string;
  code: string;
  title: string;
  to: string | null;
  toName: string | null;
};

const OPEN_STATUSES = [
  'submitted',
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
  'cancelling',
] as const;

export const OPEN_REQUEST_FILTER = { in: [...OPEN_STATUSES] };

export function memberName(user: {
  firstName: string | null;
  lastName: string | null;
  name?: string | null;
  email: string;
}) {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
    user.name ||
    user.email
  );
}

/**
 * Pure rule: every owned open request needs a destination (02 §6.4).
 * `spec` is either `{ all }` or a list covering every request.
 */
export function resolveDestinations(
  requestIds: readonly string[],
  spec: OwnedRequestsDto | undefined,
): Map<string, string> | 'missing' {
  const result = new Map<string, string>();
  if (!requestIds.length) return result;
  if (spec?.all) {
    for (const id of requestIds) result.set(id, spec.all);
    return result;
  }
  for (const item of spec?.items ?? []) result.set(item.requestId, item.to);
  return requestIds.every((id) => result.has(id)) ? result : 'missing';
}

@Injectable()
export class StaffHandoverService {
  constructor(
    private readonly hooks: ApprovalsHooks,
    private readonly audit: AuditLogsService,
  ) {}

  async openRequests(
    tx: Prisma.TransactionClient,
    staffId: string,
  ): Promise<OwnedRequestRow[]> {
    return tx.serviceRequest.findMany({
      where: { staffOwnerId: staffId, status: OPEN_REQUEST_FILTER },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        ownershipVersion: true,
      },
      orderBy: { number: 'asc' },
    });
  }

  /**
   * Validates that every owned open request has a valid destination and
   * returns the moves. Throws the spec messages when it does not.
   */
  async plan(
    tx: Prisma.TransactionClient,
    staffId: string,
    spec: OwnedRequestsDto | undefined,
    today: Date,
  ): Promise<HandoverMove[]> {
    const rows = (await this.openRequests(tx, staffId)).filter((row) =>
      isOpen(row.status),
    );
    if (!rows.length) return [];
    const destinations = resolveDestinations(
      rows.map((row) => row.id),
      spec,
    );
    if (destinations === 'missing')
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `Choose who takes over ${rows.length} open request${rows.length === 1 ? '' : 's'} first.`,
      );
    const targetIds = [...new Set(destinations.values())].filter(
      (id) => id !== QUEUE,
    );
    for (const id of targetIds) {
      if (id === staffId)
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'Choose an active staff member who can own requests.',
        );
      await this.requireEligibleSuccessor(tx, id, today);
    }
    return rows.map((request) => ({
      request,
      to:
        destinations.get(request.id) === QUEUE
          ? null
          : (destinations.get(request.id) as string),
    }));
  }

  private async requireEligibleSuccessor(
    tx: Prisma.TransactionClient,
    id: string,
    today: Date,
  ) {
    const member = await tx.staffMember.findFirst({
      where: { userId: id, status: StaffStatus.active },
      select: {
        roles: { select: { role: true } },
        leaveFrom: true,
        leaveTo: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            name: true,
            email: true,
            status: true,
          },
        },
      },
    });
    if (
      !member ||
      member.user.status !== 'active' ||
      !canOwnRequests(
        StaffStatus.active,
        member.roles.map(({ role }) => role),
      )
    )
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose an active staff member who can own requests.',
      );
    if (isOnLeave(member, today))
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `${memberName(member.user)} is on leave. Choose someone else.`,
      );
  }

  /** Moves the requests and records one audit entry and internal note each. */
  async apply(
    tx: Prisma.TransactionClient,
    actorId: string,
    moves: readonly HandoverMove[],
    note: string,
    now: Date,
  ): Promise<MovedRequest[]> {
    const names = new Map<string, string>();
    const targetIds = [
      ...new Set(moves.map((move) => move.to).filter((id) => id !== null)),
    ] as string[];
    if (targetIds.length) {
      const users = await tx.user.findMany({
        where: { id: { in: targetIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          name: true,
          email: true,
        },
      });
      for (const user of users) names.set(user.id, memberName(user));
    }
    const moved: MovedRequest[] = [];
    for (const { request, to } of moves) {
      const result = await tx.serviceRequest.updateMany({
        where: {
          id: request.id,
          ownershipVersion: request.ownershipVersion,
          status: OPEN_REQUEST_FILTER,
        },
        data: {
          staffOwnerId: to,
          claimedAt: to ? now : null,
          unclaimedSince: to ? null : now,
          ownershipVersion: { increment: 1 },
        },
      });
      if (result.count !== 1)
        throw new AppError(
          409,
          'STATE_CONFLICT',
          "This request's owner has changed. Refresh and retry.",
        );
      if (to) await this.hooks.close(tx, 'unclaimed', request.id, now, 'moved');
      else await this.hooks.open(tx, 'unclaimed', request.id, request.id, now);
      await tx.requestMessage.create({
        data: {
          requestId: request.id,
          channel: 'internal',
          authorId: actorId,
          authorRole: 'staff',
          text: to
            ? `Owner moved to ${names.get(to) ?? 'a colleague'}: ${note}`
            : `Returned to the unclaimed queue: ${note}`,
        },
      });
      this.audit.record({
        actorType: 'user',
        actorId,
        entityType: 'request',
        entityId: request.id,
        action: 'request.owner_moved',
        metadata: { note, after: { staffOwnerId: to } },
      });
      moved.push({
        requestId: request.id,
        code: formatRequestId(request.number),
        title: request.title,
        to,
        toName: to ? (names.get(to) ?? null) : null,
      });
    }
    return moved;
  }
}

/** `leaveFrom` and `leaveTo` are WAT calendar dates stored as UTC midnight. */
export function isOnLeave(
  member: { leaveFrom: Date | null; leaveTo: Date | null },
  today: Date,
): boolean {
  if (!member.leaveFrom || !member.leaveTo) return false;
  return member.leaveFrom <= today && today <= member.leaveTo;
}

/** Today's WAT (UTC+1) calendar date as UTC midnight. */
export function watToday(now = new Date()): Date {
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  return new Date(
    Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), wat.getUTCDate()),
  );
}
