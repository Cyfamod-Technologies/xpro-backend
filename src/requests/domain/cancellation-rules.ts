import type { RequestSnapshot } from './snapshot';

const HOUR_MS = 3_600_000;

/** 04 §4.7 `reasonCode`. */
export const CANCELLATION_REASON_CODES = [
  'customer_changed_mind',
  'quote_declined',
  'no_response',
  'payment_lapsed',
  'no_provider',
  'provider_no_show',
  'provider_suspended',
  'customer_suspended',
  'scope_dispute',
  'duplicate',
  'other',
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

/** The reason a customer cancellation request gets when the body has none (plan FX-3.11). */
export const DEFAULT_CUSTOMER_REASON: CancellationReasonCode =
  'customer_changed_mind';

/** 04 §4.7: any assignment on the request, current or replaced, has `workStarted`. */
export const workStartedOn = (snap: RequestSnapshot): boolean =>
  snap.assignments.some((item) => item.workStarted === true);

/** What the customer sees of a cancellation's refunds; gateway failures and Finance steps stay internal (05 §6.4). */
export type CustomerRefundStatus =
  'pending' | 'processing' | 'completed' | 'waived';

/**
 * One customer-safe status for the refunds of a cancellation (04 §6.21: "customer
 * receives refund status/receipt from 05"). Rejected refunds are ignored: 05 §6.4
 * says a new valid decision is still due, so while nothing else is open the
 * cancellation still reads as `pending`. `null` means no refund exists.
 */
export function customerRefundStatus(
  statuses: ReadonlyArray<string>,
): CustomerRefundStatus | null {
  if (!statuses.length) return null;
  const live = statuses.filter((status) => status !== 'rejected');
  if (!live.length) return 'pending';
  if (live.some((s) => ['approved', 'processing', 'failed'].includes(s)))
    return 'processing';
  if (
    live.some((s) =>
      ['pending_approval', 'awaiting_second_approval'].includes(s),
    )
  )
    return 'pending';
  return live.some((s) => s === 'completed') ? 'completed' : 'waived';
}

export type AutoConfirmRestart = {
  autoConfirmAt: Date;
  /** Only reminders that are still in the future. */
  reminders: Array<{
    kind: 'T17.reminder24h' | 'T17.reminder48h';
    dueAt: Date;
  }>;
};

/**
 * T17 after a pending cancellation on a `completion_pending` request is rejected
 * or withdrawn (FX-3.10 follow-up): the clock resumes from the original due time,
 * or one hour from now when that has passed, because auto-confirm refused to run
 * while the cancellation was pending and the timer is spent.
 */
export function autoConfirmRestart(
  input: {
    confirmDueAt: Date | null;
    reportApprovedAt: Date | null;
  },
  now: Date,
): AutoConfirmRestart | null {
  const { confirmDueAt, reportApprovedAt } = input;
  if (!confirmDueAt) return null;
  const autoConfirmAt =
    confirmDueAt > now ? confirmDueAt : new Date(now.getTime() + HOUR_MS);
  const reminders: AutoConfirmRestart['reminders'] = [];
  if (reportApprovedAt && confirmDueAt > now) {
    const first = new Date(reportApprovedAt.getTime() + 24 * HOUR_MS);
    const second = new Date(reportApprovedAt.getTime() + 48 * HOUR_MS);
    if (first > now) reminders.push({ kind: 'T17.reminder24h', dueAt: first });
    if (second > now)
      reminders.push({ kind: 'T17.reminder48h', dueAt: second });
  }
  return { autoConfirmAt, reminders };
}
