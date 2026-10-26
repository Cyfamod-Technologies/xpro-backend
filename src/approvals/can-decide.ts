import {
  approvalKindSpec,
  type SeparationRule,
} from '../requests/approvals.hooks';
import { BANK_CHANGE_SEPARATION_MS } from '../payments/domain/payout-rules';
import type { StaffPermission } from '../staff/staff-permissions';

// 02 §6.11 gives the quote example; the others follow its pattern (new messages).
export const BLOCKED_REASONS = {
  quoteLastEditor: 'You edited this quote last.',
  recorder:
    'You recorded this payment. Another staff member must reconcile it.',
  refundRequester: 'You requested this refund.',
  refundFirstApprover: 'You gave the first approval on this refund.',
  refundSecondRole: 'A super admin must give the second approval.',
  refundReconciler: 'Another Finance user must reconcile this refund.',
  bankChange:
    'Another staff member must approve this payout after the bank change.',
  payoutFirstApprover: 'You gave the first approval on this payout.',
  escalationRaiser: 'Someone else must resolve an escalation you raised.',
  escalationSuperAdmin: 'Only a super admin can resolve this escalation.',
  ownRequest: "You can't decide items on your own request.",
} as const;

export type Caller = {
  userId: string;
  permissions: ReadonlySet<string>;
  canOwn: boolean;
  isSuperAdmin: boolean;
};

/** The source rows a kind's separation rule reads; the queue loads them in batches. */
export type DecisionFacts = {
  /** The user who owns the customer account the request belongs to (02 §6.14 rule 7). */
  requestOwnerId?: string | null;
  quote?: {
    lastEditedBy: string | null;
    /** Active holders of `quote.approve` other than the caller and the last editor. */
    otherApprovers: number;
  };
  payment?: { recordedBy: string | null };
  refund?: {
    status: string;
    requestedBy: string;
    decidedBy: string | null;
    transferRecordedBy: string | null;
  };
  payout?: {
    /** Approvals given on the current bank details: `step` 1 is the first approval. */
    approvals: ReadonlyArray<{ step: number; actorId: string }>;
    bank: { reviewedBy: string | null; reviewedAt: Date | null } | null;
  };
  escalation?: { to: string; raisedBy: string | null };
  cancellation?: { paid: boolean; workStarted: boolean };
};

export type CanDecide = {
  decidingPermission: StaffPermission;
  canDecide: boolean;
  blockedReason: string | null;
};

/** The permission that decides the item; a cancellation of a paid or started job needs the stronger tier (02 §6.11). */
export function decidingPermissionFor(
  kind: string,
  facts: DecisionFacts,
): StaffPermission {
  if (
    kind === 'cancellation' &&
    (facts.cancellation?.paid || facts.cancellation?.workStarted)
  )
    return 'request.cancel.active';
  return approvalKindSpec(kind).permission;
}

function holdsPermission(
  kind: string,
  permission: StaffPermission,
  caller: Caller,
): boolean {
  if (!caller.permissions.has(permission)) return false;
  // 02 §6.11: the unclaimed item needs `request.claim` and the ability to own requests.
  return kind === 'unclaimed' ? caller.canOwn : true;
}

function separationReason(
  rule: SeparationRule,
  caller: Caller,
  facts: DecisionFacts,
  now: Date,
): string | null {
  switch (rule) {
    case 'none':
      return null;
    case 'quote_last_editor':
      // 02 §6.12: self-approval is allowed only when nobody else can approve.
      return facts.quote?.lastEditedBy === caller.userId &&
        (facts.quote.otherApprovers ?? 0) > 0
        ? BLOCKED_REASONS.quoteLastEditor
        : null;
    case 'recorder_not_reconciler':
      return facts.payment?.recordedBy === caller.userId
        ? BLOCKED_REASONS.recorder
        : null;
    case 'requester_not_decider': {
      const refund = facts.refund;
      if (!refund) return null;
      if (refund.status === 'pending_approval')
        return refund.requestedBy === caller.userId
          ? BLOCKED_REASONS.refundRequester
          : null;
      if (refund.status === 'awaiting_second_approval') {
        if (!caller.isSuperAdmin) return BLOCKED_REASONS.refundSecondRole;
        return refund.decidedBy === caller.userId
          ? BLOCKED_REASONS.refundFirstApprover
          : null;
      }
      return refund.transferRecordedBy === caller.userId ||
        refund.requestedBy === caller.userId
        ? BLOCKED_REASONS.refundReconciler
        : null;
    }
    case 'bank_change': {
      const bank = facts.payout?.bank;
      return bank?.reviewedAt &&
        bank.reviewedBy === caller.userId &&
        bank.reviewedAt.getTime() > now.getTime() - BANK_CHANGE_SEPARATION_MS
        ? BLOCKED_REASONS.bankChange
        : null;
    }
    case 'first_not_second_approver':
      return facts.payout?.approvals.some(
        (approval) => approval.step === 1 && approval.actorId === caller.userId,
      )
        ? BLOCKED_REASONS.payoutFirstApprover
        : null;
    case 'raiser_not_resolver': {
      const escalation = facts.escalation;
      if (!escalation || caller.isSuperAdmin) return null;
      if (escalation.raisedBy === caller.userId)
        return BLOCKED_REASONS.escalationRaiser;
      return escalation.to === 'super_admin'
        ? BLOCKED_REASONS.escalationSuperAdmin
        : null;
    }
  }
}

/**
 * 02 §4.6 and §6.14: the caller can decide an item when they hold the kind's
 * permission and no separation-of-duties rule blocks them. A caller without
 * the permission gets no reason: the row simply isn't theirs to act on.
 */
export function evaluateCanDecide(input: {
  kind: string;
  caller: Caller;
  facts: DecisionFacts;
  now: Date;
}): CanDecide {
  const { kind, caller, facts, now } = input;
  const decidingPermission = decidingPermissionFor(kind, facts);
  if (!holdsPermission(kind, decidingPermission, caller))
    return { decidingPermission, canDecide: false, blockedReason: null };
  const spec = approvalKindSpec(kind);
  // 02 §6.14 rule 7: staff never act on a request from their own customer account.
  const blockedReason =
    spec.scope === 'request' && facts.requestOwnerId === caller.userId
      ? BLOCKED_REASONS.ownRequest
      : separationReason(spec.separation, caller, facts, now);
  return {
    decidingPermission,
    canDecide: blockedReason === null,
    blockedReason,
  };
}
