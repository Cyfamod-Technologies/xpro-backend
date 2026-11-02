import { Injectable } from '@nestjs/common';
import { Prisma, type AssignmentStatus } from '@prisma/client';
import {
  loadLocationChain,
  locationLabelOf,
  locationPathOf,
} from '../platform/locations/location-path';
import { providerBlocked } from './domain/provider-standing';
import { parseRequestId } from './domain/statuses';
import type {
  AssignmentSnapshot,
  QuoteSnapshot,
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
  cancellations: {
    orderBy: { createdAt: 'desc' as const },
    include: { refunds: { select: { status: true } } },
  },
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
  | 'refund'
  | 'requestEscalation'
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
              Prisma.sql`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`,
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

    const assignment = currentAssignmentOf(row.assignments);
    const [
      providerCardRow,
      locationChain,
      customer,
      providerUser,
      cascadeTimer,
      uploads,
      payments,
      refundsOutstanding,
      openEscalations,
    ] = await Promise.all([
      assignment
        ? tx.providerProfile.findUnique({
            where: { userId: assignment.providerUserId },
            select: {
              trade: true,
              verification: true,
              reliabilityStatus: true,
              user: { select: { firstName: true, lastName: true } },
            },
          })
        : null,
      loadLocationChain(tx, row.locationId),
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
        select: { status: true, createdAt: true, quoteId: true },
        orderBy: { createdAt: 'desc' },
      }),
      tx.refund.count({
        where: {
          requestId: row.id,
          status: { notIn: ['completed', 'waived', 'rejected'] },
        },
      }),
      tx.requestEscalation.findMany({
        where: { requestId: row.id, resolvedAt: null },
        select: { id: true, target: true, raisedBy: true },
        orderBy: { raisedAt: 'asc' },
      }),
    ]);
    return {
      row,
      snapshot: buildSnapshot(row, {
        providerCard: providerCardRow,
        locationChain,
        customerStatus: customer?.status ?? null,
        providerUserStatus: providerUser?.status ?? null,
        cascadePending: cascadeTimer !== null,
        uploads,
        payments,
        refundsOutstanding,
        openEscalations,
      }),
    };
  }
}

/** The row columns and child rows a snapshot is built from; `LoadedRequest` and the list loader's narrow selects both satisfy it. */
export type SnapshotSource = Pick<
  LoadedRequest,
  | 'id'
  | 'number'
  | 'ownerId'
  | 'staffOwnerId'
  | 'status'
  | 'intakeState'
  | 'contactInBrief'
  | 'holdKind'
  | 'holdPreviousStatus'
  | 'autoAttempts'
  | 'defectsWindowEndsAt'
  | 'reportApprovedAt'
> & {
  workflowMode?: LoadedRequest['workflowMode'];
  assignments: Array<
    Pick<
      LoadedRequest['assignments'][number],
      | 'id'
      | 'providerUserId'
      | 'status'
      | 'attempt'
      | 'expiresAt'
      | 'workStarted'
    >
  >;
  quotes: Array<
    Pick<
      LoadedRequest['quotes'][number],
      | 'id'
      | 'status'
      | 'version'
      | 'approvalRequestedAt'
      | 'validUntil'
      | 'payoutAmount'
      | 'payoutAssignmentId'
      | 'basedOnAssignmentId'
      | 'acceptedAt'
      | 'providerChangedAt'
    >
  >;
  schedules: Array<
    Pick<
      LoadedRequest['schedules'][number],
      | 'id'
      | 'status'
      | 'startAt'
      | 'endAt'
      | 'customer'
      | 'provider'
      | 'changeRequests'
      | 'replacesScheduleId'
    >
  >;
  updates: Array<
    Pick<LoadedRequest['updates'][number], 'kind' | 'state' | 'createdAt'>
  >;
  issues: Array<Pick<LoadedRequest['issues'][number], 'status'>>;
  cancellations: Array<
    Pick<
      LoadedRequest['cancellations'][number],
      'id' | 'status' | 'requestedBy' | 'paid' | 'workStarted'
    >
  >;
  noShows: Array<Pick<LoadedRequest['noShows'][number], 'status'>>;
  contributions: Array<
    Pick<LoadedRequest['contributions'][number], 'assignmentId'>
  >;
};

export type SnapshotLookups = {
  providerCard: {
    trade: string;
    verification: string;
    reliabilityStatus: string;
    user: { firstName: string | null; lastName: string | null };
  } | null;
  customerStatus: string | null;
  providerUserStatus: string | null;
  cascadePending: boolean;
  payments: Array<{ status: string; createdAt: Date; quoteId: string }>;
  refundsOutstanding: number;
  /** Unresolved escalation rows; the list loader leaves them out. */
  openEscalations?: Array<{
    id: string;
    target: string;
    raisedBy: string | null;
  }>;
  /** The list loader leaves these out: no summary field reads them. */
  locationChain?: ReadonlyArray<{ id: string; kind: string; name: string }>;
  uploads?: Array<{
    id: string;
    fileName: string;
    size: number;
    contentType: string;
    createdAt: Date;
  }>;
};

export function currentAssignmentOf<T extends { status: AssignmentStatus }>(
  assignments: T[],
): T | null {
  return (
    assignments
      .filter((item) => CURRENT_ASSIGNMENT_STATUSES.includes(item.status))
      .at(-1) ?? null
  );
}

export function buildSnapshot(
  row: SnapshotSource,
  lookups: SnapshotLookups,
): RequestSnapshot {
  const { providerCard: providerCardRow, locationChain, uploads } = lookups;
  const { payments, refundsOutstanding } = lookups;
  const assignment = currentAssignmentOf(row.assignments);
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
  const latestSentQuote =
    row.quotes.find((quote) => quote.status === 'sent') ?? null;
  const acceptedQuote =
    row.quotes.find((quote) => quote.status === 'accepted') ?? null;
  const openIssues = row.issues.filter((issue) => issue.status !== 'resolved');
  const pendingCancellationRow =
    row.cancellations.find((item) => item.status === 'pending') ?? null;
  const settledPayments = payments.filter(
    (payment) =>
      payment.status === 'paid' || payment.status === 'partially_refunded',
  );
  // Without an accepted quote (lapsed or replaced), any settled payment on the request still counts.
  const paid = acceptedQuote
    ? settledPayments.some((payment) => payment.quoteId === acceptedQuote.id)
    : settledPayments.length > 0;
  const standing = providerBlocked({
    userStatus: lookups.providerUserStatus,
    verification: providerCardRow?.verification ?? null,
    reliabilityStatus: providerCardRow?.reliabilityStatus ?? null,
  });

  return {
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
    locationPath: locationChain ? locationPathOf(locationChain) : [],
    locationLabel: locationChain?.length
      ? locationLabelOf(locationChain)
      : null,
    locationName: locationChain?.at(-1)?.name ?? null,
    attachmentInfo: (uploads ?? []).map((upload) => ({
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
    workflowMode: row.workflowMode,
    intake: { state: row.intakeState },
    contactInBrief: row.contactInBrief,
    currentAssignment: assignment ? assignmentSnapshot(assignment) : null,
    assignments: row.assignments.map(assignmentSnapshot),
    latestQuote: latestQuote ? quoteSnapshot(latestQuote) : null,
    latestSentQuote: latestSentQuote ? quoteSnapshot(latestSentQuote) : null,
    quotes: row.quotes.map(quoteSnapshot),
    currentSchedule: currentSchedule ? scheduleSnapshot(currentSchedule) : null,
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
    pendingCancellation: pendingCancellationRow !== null,
    pendingCancellationInfo: pendingCancellationRow
      ? {
          id: pendingCancellationRow.id,
          status: 'pending',
          requestedBy: pendingCancellationRow.requestedBy,
          // Recomputed on every load so a payment or work start after the request still sets the permission tier (04 §4.7, D-20).
          paid,
          workStarted: row.assignments.some((item) => item.workStarted),
        }
      : null,
    refundsOutstanding,
    openEscalations: (lookups.openEscalations ?? []).map((item) => ({
      id: item.id,
      to: item.target === 'super_admin' ? 'super_admin' : 'operations',
      raisedBy: item.raisedBy,
    })),
    latestNoShow: row.noShows[0] ? { status: row.noShows[0].status } : null,
    payment: {
      paid,
      pendingPaymentAt:
        payments.find(
          (payment) =>
            payment.status === 'pending' || payment.status === 'recorded',
        )?.createdAt ?? null,
      offlineRecorded: payments.some(
        (payment) => payment.status === 'recorded',
      ),
    },
    payout:
      latestQuote?.payoutAmount === null || latestQuote === null
        ? null
        : {
            amount: latestQuote.payoutAmount,
            assignmentId: latestQuote.payoutAssignmentId,
          },
    customerStanding:
      lookups.customerStatus === 'suspended' ? 'suspended' : 'active',
    providerStanding: assignment ? (standing.reason ?? 'active') : null,
    cascadePending: lookups.cascadePending,
    autoAttempts: row.autoAttempts,
    hold: row.holdKind
      ? { kind: row.holdKind, previousStatus: row.holdPreviousStatus }
      : null,
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
  };
}

function quoteSnapshot(quote: SnapshotSource['quotes'][number]): QuoteSnapshot {
  return {
    status: quote.status,
    version: quote.version,
    approvalRequestedAt: quote.approvalRequestedAt,
    validUntil: quote.validUntil,
    payoutAmount: quote.payoutAmount,
    basedOnAssignmentId: quote.basedOnAssignmentId ?? undefined,
    providerChangedAt: quote.providerChangedAt,
  };
}

function assignmentSnapshot(
  assignment: SnapshotSource['assignments'][number],
): AssignmentSnapshot {
  return {
    status: assignment.status,
    attempt: assignment.attempt,
    expiresAt: assignment.expiresAt,
    workStarted: assignment.workStarted,
  };
}

function scheduleSnapshot(
  schedule: SnapshotSource['schedules'][number],
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
