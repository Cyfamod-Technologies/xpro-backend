import type { ProviderBlockReason } from './provider-standing';
import type { RequestStatus } from './statuses';

export type ActorView = {
  kind: 'customer' | 'provider' | 'staff' | 'system';
  userId?: string | null;
  platformRoles?: ReadonlyArray<string>;
  permissions?: ReadonlySet<string>;
  canOwn?: boolean;
};

export type AssignmentSnapshot = {
  status:
    | 'offered'
    | 'pending_approval'
    | 'accepted'
    | 'declined'
    | 'expired'
    | 'not_confirmed'
    | 'withdrawn'
    | 'replaced'
    | 'completed';
  attempt: number | null;
  expiresAt: Date;
};

export type QuoteSnapshot = {
  status:
    | 'draft'
    | 'sent'
    | 'accepted'
    | 'declined'
    | 'revision_requested'
    | 'superseded'
    | 'expired';
  version: number;
  approvalRequestedAt: Date | null;
  validUntil: Date | null;
  payoutAmount: number | bigint | null;
  basedOnAssignmentId?: string;
  /** Set by `assignment.replace`; the accepted quote then awaits the new provider (04 §4.6). */
  providerChangedAt?: Date | null;
};

export type ScheduleSnapshot = {
  status:
    'proposed' | 'confirmed' | 'changes_requested' | 'cancelled' | 'superseded';
  startAt: Date;
  endAt: Date;
  customer: 'pending' | 'accepted' | 'changes_requested';
  provider: 'pending' | 'accepted' | 'changes_requested';
  changeRequests: ReadonlyArray<{ handledAt: Date | null }>;
  replacesScheduleId?: string | null;
};

export type UpdateSnapshot = {
  kind:
    | 'start'
    | 'progress'
    | 'blocker'
    | 'resume'
    | 'completion'
    | 'rework'
    | 'rework_completion';
  state: 'pending' | 'approved' | 'rejected';
  createdAt?: Date;
};

export type IssueSnapshot = {
  status: 'open' | 'rework' | 'disputed' | 'resolved';
};

export type PendingCancellationSnapshot = {
  id: string;
  status: 'pending';
  requestedBy: 'customer' | 'staff' | 'system';
  paid: boolean;
  workStarted: boolean;
};

export type RequestSnapshot = {
  id: string;
  number: string;
  ownerId?: string;
  staffOwnerId?: string | null;
  currentProviderUserId?: string | null;
  accessibleProviderUserIds?: ReadonlyArray<string>;
  providerCard?: {
    businessName: string | null;
    trade: string;
    verification: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
  cityName?: string | null;
  districtName?: string | null;
  attachmentInfo?: ReadonlyArray<{
    id: string;
    name: string;
    size: number;
    type: string;
    uploadedAt: Date;
  }>;
  providerAssignmentStatus?: AssignmentSnapshot['status'] | null;
  status: RequestStatus;
  intake: { state: 'pending' | 'clarification' | 'approved' };
  contactInBrief?: boolean;
  currentAssignment: AssignmentSnapshot | null;
  assignments: ReadonlyArray<AssignmentSnapshot>;
  latestQuote: QuoteSnapshot | null;
  /** Highest-version quote with status `sent`; drafts never count (04 §6.11). */
  latestSentQuote: QuoteSnapshot | null;
  quotes: ReadonlyArray<QuoteSnapshot>;
  currentSchedule: ScheduleSnapshot | null;
  replacedSchedule: ScheduleSnapshot | null;
  pendingUpdates: ReadonlyArray<UpdateSnapshot>;
  openIssues: ReadonlyArray<IssueSnapshot>;
  pendingCancellation: boolean;
  pendingCancellationInfo: PendingCancellationSnapshot | null;
  /** Refunds for this request that are neither completed, waived nor rejected. */
  refundsOutstanding: number;
  latestNoShow: {
    status: 'open' | 'confirmed' | 'dismissed' | 'voided';
  } | null;
  payment: {
    paid: boolean;
    pendingPaymentAt: Date | null;
    /** A staff-recorded offline payment waits for a second person to reconcile it (05 §6.2). */
    offlineRecorded: boolean;
  };
  payout: {
    amount: number | bigint | null;
    assignmentId?: string | null;
  } | null;
  customerStanding: 'active' | 'suspended';
  providerStanding: 'active' | ProviderBlockReason | null;
  cascadePending: boolean;
  /** Automatic offers made so far; `resetAttempts` sets it back to 0 (04 §6.6). */
  autoAttempts: number;
  flag?: string | null;
  hold?: {
    kind: 'staff' | 'no_show' | 'provider_suspended' | 'customer_suspended';
    /** The status the job returns to on release; `scheduled` means the hold began before work. */
    previousStatus?: RequestStatus | null;
  } | null;
  defectsWindowEndsAt?: Date | null;
  completionReportApprovedAt?: Date | null;
  providerCostingSubmitted?: boolean;
  paymentLapsed?: boolean;
  replacementPayoutPending?: boolean;
};
