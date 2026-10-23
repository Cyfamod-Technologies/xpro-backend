import type { RequestStatus } from './statuses';

export type ActorView = {
  kind: 'customer' | 'provider' | 'staff' | 'system';
  userId?: string | null;
  platformRoles?: ReadonlyArray<string>;
  permissions?: ReadonlySet<string>;
  canOwn?: boolean;
};

export type AssignmentSnapshot = {
  status: 'offered' | 'pending_approval' | 'accepted' | 'declined' | 'expired' | 'not_confirmed' | 'withdrawn' | 'replaced' | 'completed';
  attempt: number | null;
  expiresAt: Date;
};

export type QuoteSnapshot = {
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'revision_requested' | 'superseded' | 'expired';
  version: number;
  approvalRequestedAt: Date | null;
  validUntil: Date | null;
  payoutAmount: number | bigint | null;
  basedOnAssignmentId?: string;
};

export type ScheduleSnapshot = {
  status: 'proposed' | 'confirmed' | 'changes_requested' | 'cancelled' | 'superseded';
  startAt: Date;
  endAt: Date;
  customer: 'pending' | 'accepted' | 'changes_requested';
  provider: 'pending' | 'accepted' | 'changes_requested';
  changeRequests: ReadonlyArray<{ handledAt: Date | null }>;
  replacesScheduleId?: string | null;
};

export type UpdateSnapshot = {
  kind: 'start' | 'progress' | 'blocker' | 'resume' | 'completion' | 'rework' | 'rework_completion';
  state: 'pending' | 'approved' | 'rejected';
  createdAt?: Date;
};

export type IssueSnapshot = {
  status: 'open' | 'rework' | 'disputed' | 'resolved';
};

export type RequestSnapshot = {
  id: string;
  number: string;
  ownerId?: string;
  staffOwnerId?: string | null;
  currentProviderUserId?: string | null;
  accessibleProviderUserIds?: ReadonlyArray<string>;
  providerCard?: { businessName: string | null; trade: string; verification: string; firstName: string | null; lastName: string | null } | null;
  cityName?: string | null;
  districtName?: string | null;
  attachmentInfo?: ReadonlyArray<{ id: string; name: string; size: number; type: string; uploadedAt: Date }>;
  providerAssignmentStatus?: AssignmentSnapshot['status'] | null;
  status: RequestStatus;
  intake: { state: 'pending' | 'clarification' | 'approved' };
  contactInBrief?: boolean;
  currentAssignment: AssignmentSnapshot | null;
  assignments: ReadonlyArray<AssignmentSnapshot>;
  latestQuote: QuoteSnapshot | null;
  quotes: ReadonlyArray<QuoteSnapshot>;
  currentSchedule: ScheduleSnapshot | null;
  replacedSchedule: ScheduleSnapshot | null;
  pendingUpdates: ReadonlyArray<UpdateSnapshot>;
  openIssues: ReadonlyArray<IssueSnapshot>;
  pendingCancellation: boolean;
  latestNoShow: { status: 'open' | 'confirmed' | 'dismissed' | 'voided' } | null;
  payment: { paid: boolean; pendingPaymentAt: Date | null };
  payout: { amount: number | bigint | null; assignmentId?: string | null } | null;
  customerStanding: 'active' | 'suspended';
  providerStanding: 'active' | 'suspended' | null;
  cascadePending: boolean;
  flag?: string | null;
  hold?: { kind: 'staff' | 'no_show' | 'provider_suspended' | 'customer_suspended' } | null;
  defectsWindowEndsAt?: Date | null;
  completionReportApprovedAt?: Date | null;
  providerCostingSubmitted?: boolean;
  paymentLapsed?: boolean;
  replacementPayoutPending?: boolean;
};
