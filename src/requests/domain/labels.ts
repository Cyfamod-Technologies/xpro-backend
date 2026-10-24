import type { RequestSnapshot } from './snapshot';
import type { RequestStage } from './stage';

export type LabelRole = 'customer' | 'provider' | 'staff';
export type LabelValues = Partial<
  Record<'n' | 'max' | 'time' | 'date' | 'kind', string | number>
>;
export type StageLabels = Readonly<Record<LabelRole, string | null>>;

export const STAGE_LABELS: Readonly<Record<RequestStage, StageLabels>> = {
  intake_review: {
    customer: 'Request sent',
    provider: null,
    staff: 'New — needs review',
  },
  awaiting_clarification: {
    customer: 'Answer XPro’s question',
    provider: null,
    staff: 'Waiting for the customer',
  },
  dispatching: {
    customer: 'Finding your provider',
    provider: null,
    staff: 'Needs assignment',
  },
  offer_out: {
    customer: 'Finding your provider',
    provider: 'Offer received — respond by {time}',
    staff: 'Offer out (attempt {n} of {max})',
  },
  acceptance_review: {
    customer: 'Finding your provider',
    provider: 'Awaiting XPro confirmation',
    staff: 'Provider accepted — confirm',
  },
  replacing_provider: {
    customer: 'XPro is assigning a new provider',
    provider: null,
    staff: 'Replacing provider',
  },
  pricing: {
    customer: 'Provider confirmed — quote in preparation',
    provider: 'Job confirmed — submit your costing',
    staff: 'Matched — build quote',
  },
  quote_approval: {
    customer: 'Provider confirmed — quote in preparation',
    provider: 'Costing sent — XPro is preparing the quote',
    staff: 'Quote awaiting sign-off',
  },
  quote_revision: {
    customer: 'XPro is revising your quote',
    provider: 'Customer asked for changes',
    staff: 'Revise quote v{n}',
  },
  quote_expired: {
    customer: 'Quote expired — XPro will send a new one',
    provider: 'Awaiting a new quote',
    staff: 'Quote expired — reissue or cancel',
  },
  payment_lapsed: {
    customer: 'Payment window closed — XPro will contact you',
    provider: 'Awaiting the customer',
    staff: 'Payment lapsed — reissue or cancel',
  },
  quote_with_customer: {
    customer: 'Quote ready — review it',
    provider: 'Awaiting customer decision',
    staff: 'Quote v{n} sent',
  },
  awaiting_payment: {
    customer: 'Payment due',
    provider: 'Awaiting customer payment',
    staff: 'Awaiting payment',
  },
  set_payout: {
    customer: 'Paid — XPro is arranging a date',
    provider: 'Job confirmed — submit your costing',
    staff: 'Set the new provider’s payout',
  },
  scheduling: {
    customer: 'Paid — XPro is arranging a date',
    provider: 'Paid — awaiting a date',
    staff: 'Paid — schedule it',
  },
  schedule_proposed: {
    customer: 'Confirm the proposed date',
    provider: 'Confirm the proposed date',
    staff: 'Date proposed — awaiting responses',
  },
  schedule_changes: {
    customer: 'Date change requested',
    provider: 'Date change requested',
    staff: 'Re-propose a date',
  },
  scheduled: {
    customer: 'Date confirmed',
    provider: 'Date confirmed',
    staff: 'Scheduled',
  },
  reschedule: {
    customer: 'Date change in progress',
    provider: 'Date change in progress',
    staff: 'Reschedule requested',
  },
  in_progress: {
    customer: 'Work in progress',
    provider: 'In progress',
    staff: 'In progress',
  },
  rework: {
    customer: 'Your provider is fixing the reported issue',
    provider: 'Rework needed',
    staff: 'Rework in progress',
  },
  blocked_provider: {
    customer: 'Work paused — XPro is handling it',
    provider: 'Blocked — XPro is working on it',
    staff: 'Blocked by provider',
  },
  on_hold: {
    customer: 'Work paused by XPro',
    provider: 'Paused by XPro Dispatch',
    staff: 'On hold — {kind}',
  },
  issue_open: {
    customer: 'Issue reported — XPro is reviewing',
    provider: 'Customer reported an issue',
    staff: 'Issue open',
  },
  dispute: {
    customer: 'Issue escalated — XPro is reviewing',
    provider: 'Under XPro review',
    staff: 'Dispute — super admin',
  },
  awaiting_customer_confirmation: {
    customer: 'Confirm completion',
    provider: 'Awaiting customer confirmation',
    staff: 'Awaiting customer confirmation',
  },
  defects_window: {
    customer: 'Completed — report a problem by {date}',
    provider: 'Customer confirmed',
    staff: 'Confirmed — defects window',
  },
  ready_to_close: {
    customer: 'Completed — XPro is closing your job',
    provider: 'Customer confirmed',
    staff: 'Ready to close',
  },
  closed: { customer: 'Completed', provider: 'Completed', staff: 'Closed' },
  refund_pending: {
    customer: 'Cancelled — refund in progress',
    provider: 'Cancelled',
    staff: 'Cancelling — refund pending',
  },
  cancelled: {
    customer: 'Cancelled',
    provider: 'Cancelled',
    staff: 'Cancelled',
  },
  rejected: { customer: 'Not accepted', provider: null, staff: 'Rejected' },
};

function interpolate(label: string, values: LabelValues): string {
  return label.replace(
    /\{(n|max|time|date|kind)\}/g,
    (token, key: keyof LabelValues) => {
      const value = values[key];
      return value === undefined ? token : String(value);
    },
  );
}

export function statusLabel(
  stage: RequestStage,
  role: LabelRole,
  values: LabelValues = {},
  snap?: RequestSnapshot,
): string | null {
  if (stage === 'replacing_provider' && role === 'provider') {
    const assignment = snap?.currentAssignment;
    if (!assignment) return null;
    return assignment.status === 'offered'
      ? interpolate('Offer received — respond by {time}', values)
      : assignment.status === 'pending_approval'
        ? 'Awaiting XPro confirmation'
        : null;
  }

  const template = STAGE_LABELS[stage][role];
  if (template === null) return null;

  if (
    stage === 'pricing' &&
    role === 'provider' &&
    snap?.providerCostingSubmitted
  ) {
    return 'Costing sent — XPro is preparing the quote';
  }
  if (
    stage === 'set_payout' &&
    role === 'provider' &&
    snap?.providerCostingSubmitted
  ) {
    return 'Costing sent';
  }
  if (stage === 'schedule_proposed' && snap?.currentSchedule) {
    const partyStatus =
      role === 'customer'
        ? snap.currentSchedule.customer
        : role === 'provider'
          ? snap.currentSchedule.provider
          : null;
    if (partyStatus === 'accepted') {
      return role === 'customer'
        ? 'Waiting for the provider to confirm'
        : 'Waiting for the customer to confirm';
    }
  }

  return interpolate(template, values);
}

export type RequestOverlays = {
  cancellation: { customer: string; staff: string } | null;
  flag: string | null;
  suspendedParties: Array<'Customer suspended' | 'Provider suspended'>;
};

export function deriveOverlays(snap: RequestSnapshot): RequestOverlays {
  return {
    cancellation: snap.pendingCancellation
      ? {
          customer: 'Cancellation requested — awaiting XPro',
          staff: 'Cancellation to decide',
        }
      : null,
    flag: snap.flag ?? null,
    suspendedParties: [
      ...(snap.customerStanding === 'suspended'
        ? (['Customer suspended'] as const)
        : []),
      ...(snap.providerStanding === 'suspended'
        ? (['Provider suspended'] as const)
        : []),
    ],
  };
}
