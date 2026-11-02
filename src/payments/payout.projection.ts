import type { Payout, Refund } from '@prisma/client';
import type { HoldSource } from './domain/payout-rules';

/** `•••• 1234`. The full account number never leaves the bank record. */
export const maskedBankAccount = (last4: string | null): string | null =>
  last4 ? `•••• ${last4}` : null;

export const payoutMethod = (row: {
  transferRecordedBy: string | null;
}): 'offline' | 'paystack' => (row.transferRecordedBy ? 'offline' : 'paystack');

const amountFor = (amount: bigint, canSeePricing: boolean): number | null =>
  canSeePricing ? Number(amount) : null;

export type PayoutQueueItem = {
  id: string;
  requestId: string;
  assignmentId: string;
  providerId: string;
  providerName: string | null;
  kind: string;
  status: string;
  /** Kobo; `null` for staff without `view.pricing` (05 §10). */
  amount: number | null;
  holdReason: string | null;
  holdSource: string | null;
  /** A transfer that is already `processing` when a hold arrives is flagged for urgent Finance review (05 §6.6). */
  urgentReview: boolean;
  approvalDueAt: Date | null;
  maskedBankAccount: string | null;
  method: 'offline' | 'paystack';
  transferReference: string | null;
  paidAt: Date | null;
  /** The `ETag` value of the record; send it back as `If-Match` (05 §11). */
  version: number;
  createdAt: Date;
};

/** What the Finance payout queue shows. Proof file ids, actor ids and the internal bank row id stay on the server (C-42, E-27). */
export function toPayoutQueueItem(
  row: Payout,
  providerName: string | null,
  canSeePricing: boolean,
): PayoutQueueItem {
  return {
    id: row.id,
    requestId: row.requestId,
    assignmentId: row.assignmentId,
    providerId: row.providerId,
    providerName,
    kind: row.kind,
    status: row.status,
    amount: amountFor(row.amount, canSeePricing),
    holdReason: row.holdReason,
    holdSource: row.holdSource,
    urgentReview: row.status === 'processing' && Boolean(row.holdReason),
    approvalDueAt: row.approvalDueAt,
    maskedBankAccount: maskedBankAccount(row.bankLast4),
    method: payoutMethod(row),
    transferReference: canSeePricing ? row.transferReference : null,
    paidAt: row.paidAt,
    version: row.version,
    createdAt: row.createdAt,
  };
}

/** The result of one payout command, for the Finance user who ran it. */
export function toPayoutDto(
  row: Payout,
  canSeePricing = true,
): PayoutQueueItem {
  return toPayoutQueueItem(row, null, canSeePricing);
}

export type RefundQueueItem = {
  id: string;
  requestId: string;
  paymentId: string;
  cancellationId: string | null;
  status: string;
  /** Kobo; `null` for staff without `view.pricing`. */
  amount: number | null;
  reason: string;
  method: string | null;
  transferPrepared: boolean;
  transferRecorded: boolean;
  /** The `ETag` value of the record; send it back as `If-Match` (05 §11). */
  version: number;
  createdAt: Date;
  completedAt: Date | null;
};

export function toRefundQueueItem(
  row: Refund,
  method: string | null,
  canSeePricing: boolean,
): RefundQueueItem {
  return {
    id: row.id,
    requestId: row.requestId,
    paymentId: row.paymentId,
    cancellationId: row.cancellationId,
    status: row.status,
    amount: amountFor(row.amount, canSeePricing),
    reason: row.reason,
    method,
    transferPrepared:
      row.transferRecordedBy !== null &&
      row.transferReference === null &&
      row.transferProofId === null,
    transferRecorded:
      row.transferReference !== null && row.transferProofId !== null,
    version: row.version,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** What a provider may be told about a hold. The staff reason is never shown (05 §10). */
export function safeHoldReason(
  status: string,
  source: string | null,
): string | null {
  if (status !== 'on_hold') return null;
  const reasons: Record<HoldSource, string | null> = {
    // new message: not in spec
    issue: 'On hold while a reported issue is reviewed.',
    // new message: not in spec
    suspension: 'On hold while your account is under review.',
    // new message: not in spec
    bank_change: 'On hold while your bank details are verified.',
    replacement: null,
    // new message: not in spec
    manual: 'On hold while XPro Finance reviews this payout.',
  };
  return (
    (source !== null && source in reasons
      ? reasons[source as HoldSource]
      : // new message: not in spec
        'On hold while XPro Finance reviews this payout.') ?? null
  );
}

export type EarningsItem = {
  id: string;
  requestId: string;
  kind: string;
  amount: number;
  status: string;
  holdReason: string | null;
  maskedBankAccount: string | null;
  method: 'offline' | 'paystack';
  paidAt: Date | null;
  createdAt: Date;
};

/** The provider's own payout line: their amount, status, masked destination and a safe hold reason. */
export function toEarningsItem(
  row: Payout,
  currentBankLast4: string | null = null,
): EarningsItem {
  return {
    id: row.id,
    requestId: row.requestId,
    kind: row.kind,
    amount: Number(row.amount),
    status: row.status,
    holdReason: safeHoldReason(row.status, row.holdSource),
    maskedBankAccount: maskedBankAccount(row.bankLast4 ?? currentBankLast4),
    method: payoutMethod(row),
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}
