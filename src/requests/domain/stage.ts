import type { RequestSnapshot, ScheduleSnapshot } from './snapshot';

export type RequestStage =
  | 'intake_review' | 'awaiting_clarification' | 'dispatching' | 'offer_out'
  | 'acceptance_review' | 'replacing_provider' | 'pricing' | 'quote_approval'
  | 'quote_revision' | 'quote_expired' | 'payment_lapsed' | 'quote_with_customer'
  | 'awaiting_payment' | 'set_payout' | 'scheduling' | 'schedule_proposed'
  | 'schedule_changes' | 'scheduled' | 'reschedule' | 'in_progress' | 'rework'
  | 'blocked_provider' | 'on_hold' | 'issue_open' | 'dispute'
  | 'awaiting_customer_confirmation' | 'defects_window' | 'ready_to_close'
  | 'closed' | 'refund_pending' | 'cancelled' | 'rejected';

export type NextActor = 'customer' | 'provider' | `staff:${string}` | 'system' | 'none';

function hasOpenChangeRequest(schedule: ScheduleSnapshot): boolean {
  return schedule.changeRequests.some((change) => change.handledAt === null);
}

export function deriveStage(snap: RequestSnapshot, now: Date): RequestStage {
  const quote = snap.latestQuote;
  const assignment = snap.currentAssignment;
  const schedule = snap.currentSchedule;

  switch (snap.status) {
    case 'submitted':
      return snap.intake.state === 'clarification' ? 'awaiting_clarification' : 'intake_review';
    case 'under_review':
      if (quote?.status === 'accepted') return 'replacing_provider';
      if (assignment?.status === 'pending_approval') return 'acceptance_review';
      if (assignment?.status === 'offered') return 'offer_out';
      return 'dispatching';
    case 'matched':
      if (quote?.status === 'revision_requested') return 'quote_revision';
      if (snap.paymentLapsed) return 'payment_lapsed';
      if (quote?.status === 'expired') return 'quote_expired';
      if (quote?.status === 'draft' && quote.approvalRequestedAt) return 'quote_approval';
      return 'pricing';
    case 'quoted':
      return 'quote_with_customer';
    case 'awaiting_payment':
      return 'awaiting_payment';
    case 'ready_to_schedule':
      if (snap.replacementPayoutPending) return 'set_payout';
      if (schedule?.status === 'proposed') return 'schedule_proposed';
      if (schedule?.status === 'changes_requested') return 'schedule_changes';
      return 'scheduling';
    case 'scheduled':
      return schedule && (hasOpenChangeRequest(schedule) || schedule.status === 'proposed') ? 'reschedule' : 'scheduled';
    case 'in_progress':
      return snap.openIssues.some((issue) => issue.status === 'rework') ? 'rework' : 'in_progress';
    case 'blocked':
      if (snap.openIssues.some((issue) => issue.status === 'disputed')) return 'dispute';
      if (snap.openIssues.some((issue) => issue.status === 'open')) return 'issue_open';
      if (snap.hold) return 'on_hold';
      return 'blocked_provider';
    case 'completion_pending':
      return 'awaiting_customer_confirmation';
    case 'acknowledged':
      return snap.defectsWindowEndsAt && now < snap.defectsWindowEndsAt ? 'defects_window' : 'ready_to_close';
    case 'closed':
      return 'closed';
    case 'cancelling':
      return 'refund_pending';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
  }
}

export function nextActor(snap: RequestSnapshot, stage: RequestStage, now: Date): NextActor {
  switch (stage) {
    case 'intake_review': return 'staff:request.review';
    case 'awaiting_clarification': return 'customer';
    case 'dispatching': return snap.cascadePending ? 'system' : 'staff:dispatch.manage';
    case 'offer_out': return 'provider';
    case 'acceptance_review': return 'staff:dispatch.manage';
    case 'replacing_provider': return nextActor(snap, snap.currentAssignment?.status === 'offered' ? 'offer_out' : snap.currentAssignment?.status === 'pending_approval' ? 'acceptance_review' : 'dispatching', now);
    case 'pricing': return snap.providerCostingSubmitted ? 'staff:quote.manage' : 'provider';
    case 'quote_approval': return 'staff:quote.approve';
    case 'quote_revision':
    case 'quote_expired':
    case 'payment_lapsed': return 'staff:quote.manage';
    case 'quote_with_customer':
    case 'awaiting_payment': return 'customer';
    case 'set_payout': return 'staff:quote.manage';
    case 'scheduling': return 'staff:schedule.manage';
    case 'schedule_proposed': return schedulePendingActor(snap.currentSchedule);
    case 'schedule_changes': return 'staff:schedule.manage';
    case 'scheduled':
      return snap.currentSchedule && now.getTime() >= snap.currentSchedule.startAt.getTime() - 2 * 60 * 60 * 1000
        ? 'provider'
        : 'none';
    case 'reschedule':
      return snap.currentSchedule?.status === 'proposed'
        ? schedulePendingActor(snap.currentSchedule)
        : 'staff:schedule.manage';
    case 'in_progress':
    case 'rework': return 'provider';
    case 'blocked_provider': return 'staff:progress.review';
    case 'on_hold': return 'staff:dispatch.manage';
    case 'issue_open': return 'staff:issue.resolve';
    case 'dispute': return 'staff:super_admin';
    case 'awaiting_customer_confirmation': return 'customer';
    case 'defects_window': return 'none';
    case 'ready_to_close': return 'staff:request.close';
    case 'refund_pending': return 'staff:refund.manage';
    case 'closed':
    case 'cancelled':
    case 'rejected': return 'none';
  }
}

function schedulePendingActor(schedule: ScheduleSnapshot | null): NextActor {
  if (!schedule) return 'staff:schedule.manage';
  if (schedule.customer === 'pending') return 'customer';
  if (schedule.provider === 'pending') return 'provider';
  return 'staff:schedule.manage';
}
