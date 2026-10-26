import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestSnapshot } from './domain/snapshot';
import {
  buildSnapshot,
  currentAssignmentOf,
  type SnapshotSource,
} from './snapshot.loader';

/** The only `service_requests` columns a list summary and its stage derivation read. */
export const LIST_ROW_SELECT = {
  id: true,
  number: true,
  ownerId: true,
  staffOwnerId: true,
  title: true,
  service: true,
  status: true,
  version: true,
  intakeState: true,
  contactInBrief: true,
  holdKind: true,
  holdPreviousStatus: true,
  autoAttempts: true,
  defectsWindowEndsAt: true,
  reportApprovedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServiceRequestSelect;

export type ListRow = Prisma.ServiceRequestGetPayload<{
  select: typeof LIST_ROW_SELECT;
}>;
export type LightRequest = { row: ListRow; snapshot: RequestSnapshot };

export type ListDb = Pick<
  Prisma.TransactionClient,
  | 'assignment'
  | 'quote'
  | 'schedule'
  | 'progressUpdate'
  | 'issue'
  | 'cancellation'
  | 'noShow'
  | 'contribution'
  | 'providerProfile'
  | 'user'
  | 'requestTimer'
  | 'payment'
  | 'refund'
>;

function groupBy<T extends { requestId: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.requestId);
    if (group) group.push(item);
    else groups.set(item.requestId, [item]);
  }
  return groups;
}

/**
 * Builds the same `RequestSnapshot` as `RequestSnapshotLoader.load`, for a page of
 * rows, with one batched query per child table instead of a full aggregate per
 * row. It leaves out only what a summary never reads: attachments, city and
 * district names, and the full child columns.
 */
@Injectable()
export class RequestListLoader {
  async attachSnapshots(db: ListDb, rows: ListRow[]): Promise<LightRequest[]> {
    if (rows.length === 0) return [];
    const requestIds = rows.map((row) => row.id);
    const inRequests = { requestId: { in: requestIds } };
    const [
      assignments,
      quotes,
      schedules,
      updates,
      issues,
      cancellations,
      noShows,
      contributions,
      cascadeTimers,
      payments,
      outstandingRefunds,
    ] = await Promise.all([
      db.assignment.findMany({
        where: inRequests,
        orderBy: { createdAt: 'asc' },
        select: {
          requestId: true,
          id: true,
          providerUserId: true,
          status: true,
          attempt: true,
          expiresAt: true,
          workStarted: true,
        },
      }),
      db.quote.findMany({
        where: inRequests,
        orderBy: { version: 'desc' },
        select: {
          requestId: true,
          id: true,
          status: true,
          version: true,
          approvalRequestedAt: true,
          validUntil: true,
          payoutAmount: true,
          payoutAssignmentId: true,
          basedOnAssignmentId: true,
          acceptedAt: true,
          providerChangedAt: true,
        },
      }),
      db.schedule.findMany({
        where: inRequests,
        orderBy: { proposedAt: 'desc' },
        select: {
          requestId: true,
          id: true,
          status: true,
          startAt: true,
          endAt: true,
          customer: true,
          provider: true,
          changeRequests: true,
          replacesScheduleId: true,
        },
      }),
      db.progressUpdate.findMany({
        where: { ...inRequests, state: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: {
          requestId: true,
          kind: true,
          state: true,
          createdAt: true,
        },
      }),
      db.issue.findMany({
        where: { ...inRequests, status: { not: 'resolved' } },
        select: { requestId: true, status: true },
      }),
      db.cancellation.findMany({
        where: { ...inRequests, status: 'pending' },
        select: {
          requestId: true,
          id: true,
          status: true,
          requestedBy: true,
          paid: true,
          workStarted: true,
        },
      }),
      db.noShow.findMany({
        where: inRequests,
        distinct: ['requestId'],
        orderBy: [{ requestId: 'asc' }, { detectedAt: 'desc' }],
        select: { requestId: true, status: true },
      }),
      db.contribution.findMany({
        where: inRequests,
        select: { requestId: true, assignmentId: true },
      }),
      db.requestTimer.findMany({
        where: {
          requestId: { in: requestIds },
          kind: 'dispatch.cascade',
          status: 'pending',
        },
        select: { requestId: true },
      }),
      db.payment.findMany({
        where: inRequests,
        orderBy: { createdAt: 'desc' },
        select: {
          requestId: true,
          status: true,
          createdAt: true,
          quoteId: true,
        },
      }),
      db.refund.groupBy({
        by: ['requestId'],
        where: {
          ...inRequests,
          status: { notIn: ['completed', 'waived', 'rejected'] },
        },
        _count: { _all: true },
      }),
    ]);

    const assignmentsByRequest = groupBy(assignments);
    const currentProviderUserIds = new Set<string>();
    for (const row of rows) {
      const current = currentAssignmentOf(
        assignmentsByRequest.get(row.id) ?? [],
      );
      if (current) currentProviderUserIds.add(current.providerUserId);
    }
    const [providerProfiles, users] = await Promise.all([
      currentProviderUserIds.size
        ? db.providerProfile.findMany({
            where: { userId: { in: [...currentProviderUserIds] } },
            select: {
              userId: true,
              trade: true,
              verification: true,
              reliabilityStatus: true,
              user: { select: { firstName: true, lastName: true } },
            },
          })
        : [],
      db.user.findMany({
        where: {
          id: {
            in: [
              ...new Set([
                ...rows.map((row) => row.ownerId),
                ...currentProviderUserIds,
              ]),
            ],
          },
        },
        select: { id: true, status: true },
      }),
    ]);
    const profileByUser = new Map(
      providerProfiles.map((profile) => [profile.userId, profile]),
    );
    const statusByUser = new Map(users.map((user) => [user.id, user.status]));
    const quotesByRequest = groupBy(quotes);
    const schedulesByRequest = groupBy(schedules);
    const updatesByRequest = groupBy(updates);
    const issuesByRequest = groupBy(issues);
    const cancellationsByRequest = groupBy(cancellations);
    const noShowsByRequest = groupBy(noShows);
    const contributionsByRequest = groupBy(contributions);
    const paymentsByRequest = groupBy(payments);
    const cascading = new Set(cascadeTimers.map((timer) => timer.requestId));
    const refundsByRequest = new Map(
      outstandingRefunds.map((group) => [group.requestId, group._count._all]),
    );

    return rows.map((row) => {
      const source: SnapshotSource = {
        ...row,
        assignments: assignmentsByRequest.get(row.id) ?? [],
        quotes: quotesByRequest.get(row.id) ?? [],
        schedules: schedulesByRequest.get(row.id) ?? [],
        updates: updatesByRequest.get(row.id) ?? [],
        issues: issuesByRequest.get(row.id) ?? [],
        cancellations: cancellationsByRequest.get(row.id) ?? [],
        noShows: noShowsByRequest.get(row.id) ?? [],
        contributions: contributionsByRequest.get(row.id) ?? [],
      };
      const current = currentAssignmentOf(source.assignments);
      const profile = current
        ? profileByUser.get(current.providerUserId)
        : null;
      return {
        row,
        snapshot: buildSnapshot(source, {
          providerCard: profile ?? null,
          customerStatus: statusByUser.get(row.ownerId) ?? null,
          providerUserStatus: current
            ? (statusByUser.get(current.providerUserId) ?? null)
            : null,
          cascadePending: cascading.has(row.id),
          payments: paymentsByRequest.get(row.id) ?? [],
          refundsOutstanding: refundsByRequest.get(row.id) ?? 0,
        }),
      };
    });
  }
}
