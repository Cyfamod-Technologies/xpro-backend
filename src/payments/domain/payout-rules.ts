import { randomUUID } from 'node:crypto';
import type { PayoutStatus } from '@prisma/client';
import { addWorkingMinutes } from '../../platform/calendar/business-calendar';
import { providerBlocked } from '../../requests/domain/provider-standing';

/**
 * Pure rules for primary payouts and their transfers (05 §4.3, §5, §6.5, §6.6,
 * §7; 02 §6.14 rules 3 and 4; 04 §6.17). Nothing here reads a database: the
 * service loads the rows, asks these functions what is allowed and then claims
 * the state it was told.
 */

export type PayoutFailure = {
  ok: false;
  status: 403 | 409 | 422;
  code: 'FORBIDDEN' | 'STATE_CONFLICT' | 'VALIDATION_ERROR';
  message: string;
};

export const PAYOUT_MESSAGES = {
  // 05 §6.5 (exact text)
  openIssue: 'Resolve the open issue before approving this payout.',
  bankDetails:
    "Verify the provider's bank details before approving this payout.",
  bankChange:
    'Another staff member must approve this payout after the bank change.',
  // new message: not in spec
  notAwaitingApproval: 'This payout is not awaiting approval.',
  // new message: not in spec
  requestNotAcknowledged:
    'The request must be acknowledged before this payout can be approved.',
  // new message: not in spec
  collectionNotSettled:
    "The customer's payment must be settled before this payout can be approved.",
  // new message: not in spec
  requestHold: 'Release the request hold before approving this payout.',
  // new message: not in spec (the existing text, kept)
  providerInactive:
    'Provider must be active before this payout can be approved.',
  // new message: not in spec
  notAwaitingSecond: 'This payout is not awaiting a second approval.',
  // new message: not in spec
  secondApprover: 'Another staff member must give the second approval.',
  // new message: not in spec
  secondNote: 'Add a note for the second approval.',
  // new message: not in spec
  bankChangedSinceApproval:
    'The provider bank details changed after approval. Review the bank account and approve again.',
  // new message: not in spec
  addReason: 'Add a reason for this payout action.',
  // new message: not in spec
  cannotHold: 'This payout can no longer be held.',
  // new message: not in spec
  notOnHold: 'This payout is not on hold.',
  // new message: not in spec (the existing text, kept)
  releaseBlocked:
    'Resolve the request hold, open issue or provider suspension before releasing this payout.',
  // new message: not in spec
  notApprovedForTransfer: 'This payout is not approved for transfer.',
  // new message: not in spec
  transferInProgress:
    'A transfer for this payout is already in progress. Use retry to check it with Paystack.',
  // new message: not in spec
  notRetryable: 'This payout cannot be retried.',
  // new message: not in spec
  stillWithPaystack:
    'The earlier transfer is still with Paystack. Check it again in a few minutes.',
  // new message: not in spec
  noPayoutAmount: 'Set the provider payout before confirming completion.',
  // new message: not in spec
  otherPrimaryActive:
    'A payout for another provider is already in progress on this request. Ask Finance to resolve it first.',
  // new message: not in spec
  reconciler: 'Another Finance user must reconcile this transfer.',
  // new message: not in spec
  reconcileNote: 'Add a reconciliation note.',
  // new message: not in spec
  holdIssue: 'An issue is open on this request.',
  // new message: not in spec
  holdSuspension:
    'The provider cannot receive payouts (suspended, delisted or restricted).',
  // new message: not in spec
  badStatusFilter: 'Choose a valid status.',
} as const;

const fail = (
  status: PayoutFailure['status'],
  code: PayoutFailure['code'],
  message: string,
): PayoutFailure => ({ ok: false, status, code, message });
const conflict = (message: string) => fail(409, 'STATE_CONFLICT', message);
const forbidden = (message: string) => fail(403, 'FORBIDDEN', message);

/** 04 §6.17 and 05 §6.5: an issue in any of these states blocks approval and closure. */
export const BLOCKING_ISSUE_STATUSES = ['open', 'rework', 'disputed'] as const;
export const isBlockingIssue = (status: string): boolean =>
  (BLOCKING_ISSUE_STATUSES as readonly string[]).includes(status);

/** Approval needs a request in one of these states (05 §6.5). */
export const APPROVABLE_REQUEST_STATUSES = ['acknowledged', 'closed'] as const;

/** Q14 and 02 §6.14 rule 4. */
export const BANK_CHANGE_SEPARATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where a hold came from (C-40). The actor is recorded in the audit row, never
 * in this column. The column is a plain string, so every value is checked here.
 */
export const HOLD_SOURCES = [
  'manual',
  'issue',
  'suspension',
  'bank_change',
  'replacement',
] as const;
export type HoldSource = (typeof HOLD_SOURCES)[number];

/** Payout work item (02 §6.11) for a payout's first approval, in working minutes. */
export const DEFAULT_PAYOUT_APPROVAL_MINUTES = 20 * 60;

/** What identifies the bank details an approval covered. `updatedAt` is not used: saving the Paystack recipient code touches it. */
export const bankVersionOf = (bank: {
  id: string;
  reviewedAt: Date | null;
  createdAt: Date;
}): string => `${bank.id}:${(bank.reviewedAt ?? bank.createdAt).toISOString()}`;

export type ApprovalRow = {
  step: number;
  actorId: string;
  bankVersion: string | null;
};

/** Approvals given for the bank details that are current now. A different bank makes the earlier sign-offs void (C-40). */
export const currentApprovals = <T extends ApprovalRow>(
  approvals: readonly T[],
  currentBankVersion: string | null,
): T[] =>
  approvals.filter(
    (approval) =>
      currentBankVersion !== null &&
      approval.bankVersion === currentBankVersion,
  );

export type BankFacts = {
  state: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
};

export type ApprovalInput = {
  approverId: string;
  now: Date;
  requestStatus: string;
  /** The request holds (`staff`, `no_show`, ...); `null` when it does not. */
  requestHold: string | null;
  issueStatuses: readonly string[];
  collectionSettled: boolean;
  provider: {
    userStatus: string | null;
    verification: string | null;
    reliabilityStatus: string | null;
  };
  /** The provider's current verified bank row, if any. */
  bank: BankFacts | null;
  /** A bank change is waiting for review. */
  pendingBankChange: boolean;
};

/**
 * 05 §6.5 `payout.approve` re-checks, in the order the spec lists them:
 * acknowledged request, settled collection, no open issue, no request hold,
 * active account and profile, the current bank and the seven-day separation.
 */
export function checkPayoutApproval(
  input: ApprovalInput,
): PayoutFailure | null {
  if (
    !(APPROVABLE_REQUEST_STATUSES as readonly string[]).includes(
      input.requestStatus,
    )
  )
    return conflict(PAYOUT_MESSAGES.requestNotAcknowledged);
  if (!input.collectionSettled)
    return conflict(PAYOUT_MESSAGES.collectionNotSettled);
  if (input.issueStatuses.some(isBlockingIssue))
    return conflict(PAYOUT_MESSAGES.openIssue);
  if (input.requestHold) return conflict(PAYOUT_MESSAGES.requestHold);
  if (
    providerBlocked({
      userStatus: input.provider.userStatus,
      verification: input.provider.verification,
      reliabilityStatus: input.provider.reliabilityStatus,
    }).blocked
  )
    return conflict(PAYOUT_MESSAGES.providerInactive);
  if (input.pendingBankChange || !input.bank || input.bank.state !== 'verified')
    return conflict(PAYOUT_MESSAGES.bankDetails);
  const { reviewedAt, reviewedBy } = input.bank;
  if (
    reviewedAt &&
    reviewedBy === input.approverId &&
    reviewedAt.getTime() > input.now.getTime() - BANK_CHANGE_SEPARATION_MS
  )
    return forbidden(PAYOUT_MESSAGES.bankChange);
  return null;
}

/** PAY-5: a second approval is needed only for an amount above a positive threshold; `null` or an invalid value means off. */
export function needsSecondApproval(
  amount: bigint,
  threshold: unknown,
): boolean {
  if (
    typeof threshold !== 'number' ||
    !Number.isSafeInteger(threshold) ||
    threshold <= 0
  )
    return false;
  return amount > BigInt(threshold);
}

/** Q14 and PAY-5: anyone with `payout.approve` except the person who gave the first approval. */
export function checkSecondApprover(input: {
  userId: string;
  approvals: readonly ApprovalRow[];
}): PayoutFailure | null {
  return input.approvals.some(
    (approval) => approval.step === 1 && approval.actorId === input.userId,
  )
    ? forbidden(PAYOUT_MESSAGES.secondApprover)
    : null;
}

export type SecondApprovalPlan =
  { ok: true; status: 'approved' | 'pending_approval' } | PayoutFailure;

/** 05 §5: an approval goes on to `approved`; a rejection returns the payout to `pending_approval` with the note. */
export function planSecondApproval(input: {
  approve: boolean;
  note: string;
  firstApprovalCurrent: boolean;
}): SecondApprovalPlan {
  if (!input.note.trim())
    return fail(422, 'VALIDATION_ERROR', PAYOUT_MESSAGES.secondNote);
  if (input.approve && !input.firstApprovalCurrent)
    return conflict(PAYOUT_MESSAGES.bankChangedSinceApproval);
  return { ok: true, status: input.approve ? 'approved' : 'pending_approval' };
}

export type PrimaryPayoutPlan = {
  status: 'pending_approval' | 'on_hold';
  holdSource: HoldSource | null;
  holdReason: string | null;
  approvalDueAt: Date;
};

/**
 * PAY-4 and 05 §6.5: the primary payout is due for first approval 20 working
 * hours after confirmation, and starts `on_hold` at once when an issue is
 * open, rework or disputed, or when the provider cannot receive payouts. An
 * issue wins over a suspension when both apply.
 */
export function planPrimaryPayout(input: {
  now: Date;
  holidays: readonly string[];
  approvalMinutes?: number;
  issueStatuses: readonly string[];
  provider: {
    userStatus: string | null;
    verification: string | null;
    reliabilityStatus: string | null;
  };
}): PrimaryPayoutPlan {
  const approvalDueAt = addWorkingMinutes(
    input.now,
    input.approvalMinutes ?? DEFAULT_PAYOUT_APPROVAL_MINUTES,
    input.holidays,
  );
  if (input.issueStatuses.some(isBlockingIssue))
    return {
      status: 'on_hold',
      holdSource: 'issue',
      holdReason: PAYOUT_MESSAGES.holdIssue,
      approvalDueAt,
    };
  if (providerBlocked(input.provider).blocked)
    return {
      status: 'on_hold',
      holdSource: 'suspension',
      holdReason: PAYOUT_MESSAGES.holdSuspension,
      approvalDueAt,
    };
  return {
    status: 'pending_approval',
    holdSource: null,
    holdReason: null,
    approvalDueAt,
  };
}

/**
 * What a hold does to a payout in each status (05 §5, §6.6): an unpaid payout
 * goes `on_hold`; a `processing` transfer cannot be stopped, so it is flagged
 * for urgent Finance review instead; anything else cannot be held.
 */
export function holdAction(status: string): 'hold' | 'flag' | null {
  if (
    [
      'pending_approval',
      'awaiting_second_approval',
      'approved',
      'failed',
    ].includes(status)
  )
    return 'hold';
  return status === 'processing' ? 'flag' : null;
}

/** Release re-runs the checks that created the hold (05 §6.6). */
export function checkRelease(input: {
  issueStatuses: readonly string[];
  requestHold: string | null;
  provider: {
    userStatus: string | null;
    verification: string | null;
    reliabilityStatus: string | null;
  };
  holdSource: string | null;
  pendingBankChange: boolean;
}): PayoutFailure | null {
  if (
    input.issueStatuses.some(isBlockingIssue) ||
    input.requestHold ||
    providerBlocked(input.provider).blocked
  )
    return conflict(PAYOUT_MESSAGES.releaseBlocked);
  if (input.holdSource === 'bank_change' && input.pendingBankChange)
    return conflict(PAYOUT_MESSAGES.bankDetails);
  return null;
}

export type PayoutRow = {
  kind: string;
  status: string;
  holdReason: string | null;
};

export type ClosureState = {
  state: 'paid' | 'on_hold_with_reason' | 'blocked';
  reason?: string;
};

/**
 * 04 §6.17 and 05 §5: a request may close only when its primary payout is
 * `paid`, or `on_hold` with a recorded reason. Cancelled rows (a replaced
 * provider's payout) and compensation payouts are not the primary obligation.
 */
export function closureStateOf(rows: readonly PayoutRow[]): ClosureState {
  const primary = rows.filter(
    (row) => row.kind === 'primary' && row.status !== 'cancelled',
  );
  if (!primary.length)
    return { state: 'blocked', reason: 'No provider payout has been created.' };
  const unfinished = primary.filter((row) => row.status !== 'paid');
  if (!unfinished.length) return { state: 'paid' };
  const unreasoned = unfinished.find(
    (row) => row.status !== 'on_hold' || !row.holdReason?.trim(),
  );
  if (unreasoned)
    return {
      state: 'blocked',
      reason:
        unreasoned.status === 'on_hold'
          ? 'A provider payout hold needs a recorded reason.'
          : 'A provider payout is still pending.',
    };
  return {
    state: 'on_hold_with_reason',
    reason: unfinished[0].holdReason ?? undefined,
  };
}

/** FD-8 and C-23: `xpro_tr_` and 32 lowercase hex characters, 40 in total. */
export const TRANSFER_REFERENCE_PATTERN = /^xpro_tr_[0-9a-f]{32}$/;
export const newTransferReference = (uuid: () => string = randomUUID): string =>
  `xpro_tr_${uuid().replaceAll('-', '').toLowerCase()}`;

export type GatewayTransferState =
  'success' | 'failed' | 'reversed' | 'otp' | 'in_flight';

/**
 * Paystack transfer statuses: `success` is paid out, `failed` and `reversed`
 * did not (or no longer) reach the recipient, `otp` waits for a Finance
 * confirmation in Paystack. Anything unrecognised, such as `pending`,
 * `received` or `processing`, is treated as in flight so it is never retried by guess.
 */
export function classifyGatewayTransfer(status: string): GatewayTransferState {
  const normal = status.toLowerCase();
  if (normal === 'success') return 'success';
  if (normal === 'reversed') return 'reversed';
  if (['failed', 'rejected', 'blocked', 'abandoned'].includes(normal))
    return 'failed';
  if (normal === 'otp') return 'otp';
  return 'in_flight';
}

/** A transfer submitted with no outcome recorded is left alone for this long before it may be checked and resubmitted (the gateway call times out at 12 s). */
export const TRANSFER_RETRY_COOLDOWN_MS = 2 * 60_000;

export const withinTransferCooldown = (submittedAt: Date, now: Date): boolean =>
  now.getTime() - submittedAt.getTime() < TRANSFER_RETRY_COOLDOWN_MS;

export type RetryDecision =
  | { action: 'settle'; outcome: 'success' | 'reversed' }
  | { action: 'resubmit'; previous: 'failed' | 'reversed' | 'not_found' }
  | { action: 'wait'; message: string }
  | { action: 'refuse'; message: string };

/**
 * 05 §6.5 and §7: "retry first verifies the previous transfer state". A new
 * attempt is created only when Paystack confirms the earlier one `failed` or
 * `reversed`, or does not know its reference at all (`verified` is `null`). A
 * transfer that succeeded is settled instead; one still on its way is waited for.
 */
export function decideTransferRetry(input: {
  payoutStatus: string;
  offline: boolean;
  latestAttempt: { status: string; submittedAt: Date } | null;
  /** The gateway's answer for the latest attempt's reference; `null` when Paystack does not know it. */
  verified: { status: string } | null;
  now: Date;
}): RetryDecision {
  if (
    input.offline ||
    !['processing', 'failed', 'reversed'].includes(input.payoutStatus) ||
    !input.latestAttempt
  )
    return { action: 'refuse', message: PAYOUT_MESSAGES.notRetryable };
  if (
    !input.verified &&
    withinTransferCooldown(input.latestAttempt.submittedAt, input.now)
  )
    return { action: 'wait', message: PAYOUT_MESSAGES.stillWithPaystack };
  if (!input.verified) return { action: 'resubmit', previous: 'not_found' };
  switch (classifyGatewayTransfer(input.verified.status)) {
    case 'success':
      return { action: 'settle', outcome: 'success' };
    case 'failed':
      return { action: 'resubmit', previous: 'failed' };
    case 'reversed':
      return { action: 'resubmit', previous: 'reversed' };
    default:
      return { action: 'wait', message: PAYOUT_MESSAGES.stillWithPaystack };
  }
}

export type TransferOutcome = 'success' | 'failed' | 'reversed';

const TRANSFER_TRANSITIONS: Record<
  TransferOutcome,
  { to: 'paid' | 'failed' | 'reversed'; from: readonly PayoutStatus[] }
> = {
  success: { to: 'paid', from: ['processing', 'failed'] },
  failed: { to: 'failed', from: ['processing'] },
  reversed: { to: 'reversed', from: ['processing', 'paid'] },
};

export type TransferEventPlan = {
  /** The attempt row always records what the gateway said. */
  attemptStatus: TransferOutcome;
  /** The payout moves only for the latest attempt and a matching amount; `null` leaves it alone. */
  payout: {
    to: 'paid' | 'failed' | 'reversed';
    from: readonly PayoutStatus[];
  } | null;
  reason?: 'not_latest' | 'amount_mismatch';
};

/** C-19: a late event for an earlier attempt, or one for a different amount, never overwrites the payout. */
export function planTransferEvent(input: {
  outcome: TransferOutcome;
  attemptId: string;
  latestAttemptId: string;
  attemptAmount: bigint;
  payoutAmount: bigint;
  verifiedAmount?: number | null;
}): TransferEventPlan {
  const base = { attemptStatus: input.outcome };
  if (input.attemptId !== input.latestAttemptId)
    return { ...base, payout: null, reason: 'not_latest' };
  if (
    input.attemptAmount !== input.payoutAmount ||
    (input.verifiedAmount != null &&
      BigInt(input.verifiedAmount) !== input.attemptAmount)
  )
    return { ...base, payout: null, reason: 'amount_mismatch' };
  return { ...base, payout: TRANSFER_TRANSITIONS[input.outcome] };
}

/** `?status` filter for the finance queues: absent means no filter, anything outside the allowed values is refused. */
export function parseStatusFilter<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): { ok: true; status: T | undefined } | PayoutFailure {
  if (value === undefined || value === '')
    return { ok: true, status: undefined };
  return (allowed as readonly string[]).includes(value)
    ? { ok: true, status: value as T }
    : fail(422, 'VALIDATION_ERROR', PAYOUT_MESSAGES.badStatusFilter);
}
