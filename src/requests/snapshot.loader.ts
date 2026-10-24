import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseRequestId } from './domain/statuses';
import type {
  AssignmentSnapshot,
  RequestSnapshot,
  ScheduleSnapshot,
} from './domain/snapshot';

export const REQUEST_INCLUDE = {
  attachments: true,
  assignments: { orderBy: { createdAt: 'asc' as const } },
  runs: { orderBy: { createdAt: 'desc' as const } },
  contributions: { orderBy: { createdAt: 'desc' as const } },
  quotes: { orderBy: { version: 'desc' as const } },
  schedules: { orderBy: { proposedAt: 'desc' as const } },
  updates: { orderBy: { createdAt: 'desc' as const } },
  issues: { orderBy: { raisedAt: 'desc' as const } },
  cancellations: { orderBy: { createdAt: 'desc' as const } },
  noShows: { orderBy: { detectedAt: 'desc' as const } },
  messages: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.ServiceRequestInclude;

export type LoadedRequest = Prisma.ServiceRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;
export type RequestDb = Pick<
  Prisma.TransactionClient,
  | 'serviceRequest'
  | 'providerProfile'
  | 'location'
  | 'user'
  | 'requestTimer'
  | 'payment'
  | 'upload'
  | '$queryRaw'
>;

const CURRENT_ASSIGNMENT_STATUSES: AssignmentSnapshot['status'][] = [
  'offered',
  'pending_approval',
  'accepted',
  'completed',
];

@Injectable()
export class RequestSnapshotLoader {
  async load(
    tx: RequestDb,
    requestId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<{ row: LoadedRequest; snapshot: RequestSnapshot } | null> {
    let uuid = requestId;
    if (options.forUpdate) {
      const sequence = parseRequestId(requestId);
      if (
        sequence === null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId,
        )
      )
        return null;
      const rows =
        sequence === null
          ? await tx.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`SELECT id FROM service_requests WHERE id = ${requestId}::uuid FOR UPDATE`,
            )
          : await tx.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`SELECT id FROM service_requests WHERE number = ${sequence} FOR UPDATE`,
            );
      if (!rows[0]) return null;
      uuid = rows[0].id;
    } else if (parseRequestId(requestId) !== null) {
      const row = await tx.serviceRequest.findUnique({
        where: { number: parseRequestId(requestId)! },
        select: { id: true },
      });
      if (!row) return null;
      uuid = row.id;
    } else if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    ) {
      return null;
    }

    const row = await tx.serviceRequest.findUnique({
      where: { id: uuid },
      include: REQUEST_INCLUDE,
    });
    if (!row) return null;

    const activeAssignments = row.assignments.filter((item) =>
      CURRENT_ASSIGNMENT_STATUSES.includes(item.status),
    );
    const assignment = activeAssignments.at(-1) ?? null;
    const schedules = row.schedules;
    // A live reschedule proposal supersedes the prior confirmed schedule even
    // if imported/legacy proposedAt values do not sort after it.
    const currentSchedule =
      schedules.find(
        (item) =>
          item.status === 'proposed' || item.status === 'changes_requested',
      ) ??
      schedules.find((item) => item.status === 'confirmed') ??
      null;
    const replacedSchedule = currentSchedule?.replacesScheduleId
      ? (schedules.find(
          (item) => item.id === currentSchedule.replacesScheduleId,
        ) ?? null)
      : null;
    const latestQuote = row.quotes[0] ?? null;
    const openIssues = row.issues.filter(
      (issue) => issue.status !== 'resolved',
    );
    const pendingCancellation = row.cancellations.some(
      (item) => item.status === 'pending',
    );
    const [
      providerCardRow,
      city,
      district,
      customer,
      providerUser,
      cascadeTimer,
      uploads,
      payments,
    ] = await Promise.all([
      assignment
        ? tx.providerProfile.findUnique({
            where: { userId: assignment.providerUserId },
            select: {
              trade: true,
              verification: true,
              user: { select: { firstName: true, lastName: true } },
            },
          })
        : null,
      tx.location.findUnique({
        where: { id: row.cityId },
        select: { name: true },
      }),
      tx.location.findUnique({
        where: { id: row.districtId },
        select: { name: true },
      }),
      tx.user.findUnique({
        where: { id: row.ownerId },
        select: { status: true },
      }),
      assignment
        ? tx.user.findUnique({
            where: { id: assignment.providerUserId },
            select: { status: true },
          })
        : null,
      tx.requestTimer.findFirst({
        where: {
          requestId: row.id,
          kind: 'dispatch.cascade',
          status: 'pending',
        },
        select: { id: true },
      }),
      row.attachments.length
        ? tx.upload.findMany({
            where: {
              id: { in: row.attachments.map(({ uploadId }) => uploadId) },
            },
            select: {
              id: true,
              fileName: true,
              size: true,
              contentType: true,
              createdAt: true,
            },
          })
        : [],
      tx.payment.findMany({
        where: { requestId: row.id },
        select: { status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      row,
      snapshot: {
        id: row.id,
        number: `XPR-${String(row.number).padStart(5, '0')}`,
        ownerId: row.ownerId,
        staffOwnerId: row.staffOwnerId,
        currentProviderUserId: assignment?.providerUserId ?? null,
        providerCard: providerCardRow
          ? {
              // businessName belongs to the later provider-profile schema work;
              // keep the projection's documented name/trade fallback available.
              businessName: null,
              trade: providerCardRow.trade,
              verification: providerCardRow.verification,
              firstName: providerCardRow.user.firstName,
              lastName: providerCardRow.user.lastName,
            }
          : null,
        cityName: city?.name ?? null,
        districtName: district?.name ?? null,
        attachmentInfo: uploads.map((upload) => ({
          id: upload.id,
          name: upload.fileName,
          size: upload.size,
          type: upload.contentType,
          uploadedAt: upload.createdAt,
        })),
        accessibleProviderUserIds: row.assignments
          .filter((item) => CURRENT_ASSIGNMENT_STATUSES.includes(item.status))
          .map((item) => item.providerUserId),
        providerAssignmentStatus: assignment?.status ?? null,
        status: row.status,
        intake: { state: row.intakeState },
        contactInBrief: row.contactInBrief,
        currentAssignment: assignment ? assignmentSnapshot(assignment) : null,
        assignments: row.assignments.map(assignmentSnapshot),
        latestQuote: latestQuote
          ? {
              status: latestQuote.status,
              version: latestQuote.version,
              approvalRequestedAt: latestQuote.approvalRequestedAt,
              validUntil: latestQuote.validUntil,
              payoutAmount: latestQuote.payoutAmount,
              basedOnAssignmentId: latestQuote.basedOnAssignmentId ?? undefined,
            }
          : null,
        quotes: row.quotes.map((quote) => ({
          status: quote.status,
          version: quote.version,
          approvalRequestedAt: quote.approvalRequestedAt,
          validUntil: quote.validUntil,
          payoutAmount: quote.payoutAmount,
          basedOnAssignmentId: quote.basedOnAssignmentId ?? undefined,
        })),
        currentSchedule: currentSchedule
          ? scheduleSnapshot(currentSchedule)
          : null,
        replacedSchedule: replacedSchedule
          ? scheduleSnapshot(replacedSchedule)
          : null,
        pendingUpdates: row.updates
          .filter((item) => item.state === 'pending')
          .map((item) => ({
            kind: item.kind,
            state: item.state,
            createdAt: item.createdAt,
          })),
        openIssues: openIssues.map((issue) => ({ status: issue.status })),
        pendingCancellation,
        latestNoShow: row.noShows[0] ? { status: row.noShows[0].status } : null,
        payment: {
          paid: payments.some(
            (payment) =>
              payment.status === 'paid' ||
              payment.status === 'partially_refunded',
          ),
          pendingPaymentAt:
            payments.find(
              (payment) =>
                payment.status === 'pending' || payment.status === 'recorded',
            )?.createdAt ?? null,
        },
        payout:
          latestQuote?.payoutAmount === null || latestQuote === null
            ? null
            : {
                amount: latestQuote.payoutAmount,
                assignmentId: latestQuote.payoutAssignmentId,
              },
        customerStanding:
          customer?.status === 'suspended' ? 'suspended' : 'active',
        providerStanding: assignment
          ? providerUser?.status === 'suspended'
            ? 'suspended'
            : 'active'
          : null,
        cascadePending: cascadeTimer !== null,
        hold: row.holdKind ? { kind: row.holdKind } : null,
        defectsWindowEndsAt: row.defectsWindowEndsAt,
        completionReportApprovedAt: row.reportApprovedAt,
        providerCostingSubmitted:
          assignment !== null &&
          row.contributions.some((item) => item.assignmentId === assignment.id),
        paymentLapsed:
          latestQuote?.status === 'expired' && latestQuote.acceptedAt !== null,
        replacementPayoutPending:
          row.status === 'ready_to_schedule' &&
          latestQuote?.status === 'accepted' &&
          latestQuote.providerChangedAt !== null &&
          (!assignment || latestQuote.payoutAssignmentId !== assignment.id),
      },
    };
  }
}

function assignmentSnapshot(
  assignment: LoadedRequest['assignments'][number],
): AssignmentSnapshot {
  return {
    status: assignment.status,
    attempt: assignment.attempt,
    expiresAt: assignment.expiresAt,
  };
}

function scheduleSnapshot(
  schedule: LoadedRequest['schedules'][number],
): ScheduleSnapshot {
  const changes = Array.isArray(schedule.changeRequests)
    ? (schedule.changeRequests as Array<{ handledAt?: string | null }>)
    : [];
  return {
    status: schedule.status,
    startAt: schedule.startAt,
    endAt: schedule.endAt,
    customer: schedule.customer,
    provider: schedule.provider,
    changeRequests: changes.map(({ handledAt }) => ({
      handledAt: handledAt ? new Date(handledAt) : null,
    })),
    replacesScheduleId: schedule.replacesScheduleId,
  };
}
