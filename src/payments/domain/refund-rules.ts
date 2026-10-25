/**
 * Pure rules for refund decisions (05 §4.2, §5, §6.4, §7; 02 §6.14 rules 5
 * and 6). Nothing here reads a database: the service loads the rows, asks
 * these functions what is allowed and then claims the state it was told.
 */

export type RefundFailure = {
  ok: false;
  status: 403 | 409 | 422;
  code: 'FORBIDDEN' | 'STATE_CONFLICT' | 'VALIDATION_ERROR';
  message: string;
};

export const REFUND_MESSAGES = {
  // 05 §6.4 (new in 05, exact text)
  decider: 'Another staff member must decide this refund.',
  explainAmount: 'Explain the refund amount after work has started.',
  exceeds: 'This refund exceeds the amount available.',
  // new message: not in spec
  addReason: 'Add a reason for this refund decision.',
  // new message: not in spec
  enterAmount: 'Enter the approved refund amount after work has started.',
  // new message: not in spec
  fullBalance:
    'The full refundable balance must be refunded before work starts.',
  // new message: not in spec
  nothingLeft: 'There is nothing left to refund on this payment.',
  // new message: not in spec (the existing text, kept)
  zeroBeforeWork: 'A zero refund can only be waived after work has started.',
  // new message: not in spec
  reconciler: 'Another Finance user must reconcile this refund.',
  // The shared staff-role text from actor.guards.
  secondRole: 'Your staff role does not allow this action.',
} as const;

const fail = (
  status: RefundFailure['status'],
  code: RefundFailure['code'],
  message: string,
): RefundFailure => ({ ok: false, status, code, message });

const invalid = (message: string) => fail(422, 'VALIDATION_ERROR', message);
const forbidden = (message: string) => fail(403, 'FORBIDDEN', message);

/** Refunds in these states no longer hold any of the payment. */
const RELEASED_STATUSES = new Set(['rejected', 'failed']);

export type BalanceRow = { amount: bigint; status: string };

/**
 * What is still refundable on one payment: the amount paid less every refund
 * that holds money (pending, approved, processing, completed or waived). A
 * rejected or failed refund holds nothing. Never below zero.
 */
export function refundableBalance(
  paid: bigint,
  refunds: readonly BalanceRow[],
): bigint {
  const held = refunds
    .filter((refund) => !RELEASED_STATUSES.has(refund.status))
    .reduce((sum, refund) => sum + refund.amount, 0n);
  return paid > held ? paid - held : 0n;
}

/**
 * `before_work` and `after_work` apply to a refund raised by a cancellation
 * (05 §6.4). Any other refund (a late payment, a staff request) is
 * `standalone`: one decider, any amount from 1 up to the balance.
 */
export type RefundRegime = 'before_work' | 'after_work' | 'standalone';

export const refundRegime = (
  cancellation: { workStarted: boolean } | null,
): RefundRegime =>
  !cancellation
    ? 'standalone'
    : cancellation.workStarted
      ? 'after_work'
      : 'before_work';

export type DecisionPlan =
  | {
      ok: true;
      status: 'rejected' | 'approved' | 'awaiting_second_approval';
      amount: bigint;
    }
  | RefundFailure;

export type DecisionInput = {
  regime: RefundRegime;
  approve: boolean;
  reason: string;
  /** The amount in the request body, if any. */
  requestedAmount: bigint | undefined;
  /** The amount the refund row holds now. */
  currentAmount: bigint;
  /** `refundableBalance` for the payment, ignoring this refund. */
  balance: bigint;
};

/**
 * 05 §6.4 and 04 §6.21. Before work starts only the full refundable balance
 * can be approved; leaving the amount out approves exactly that, and any other
 * amount is refused. After work starts every approval, including a zero one,
 * waits for a second (Super admin) decision. A rejection needs only a reason.
 */
export function planDecision(input: DecisionInput): DecisionPlan {
  const reason = input.reason.trim();
  if (!input.approve) {
    if (!reason) return invalid(REFUND_MESSAGES.addReason);
    return { ok: true, status: 'rejected', amount: input.currentAmount };
  }
  if (!reason)
    return invalid(
      input.regime === 'after_work'
        ? REFUND_MESSAGES.explainAmount
        : REFUND_MESSAGES.addReason,
    );
  const { balance, requestedAmount } = input;
  if (requestedAmount !== undefined && requestedAmount < 0n)
    return invalid(REFUND_MESSAGES.exceeds);
  switch (input.regime) {
    case 'after_work': {
      if (requestedAmount === undefined)
        return invalid(REFUND_MESSAGES.enterAmount);
      if (requestedAmount > balance) return invalid(REFUND_MESSAGES.exceeds);
      return {
        ok: true,
        status: 'awaiting_second_approval',
        amount: requestedAmount,
      };
    }
    case 'before_work': {
      if (balance <= 0n) return invalid(REFUND_MESSAGES.nothingLeft);
      if (requestedAmount !== undefined) {
        if (requestedAmount > balance) return invalid(REFUND_MESSAGES.exceeds);
        if (requestedAmount < balance)
          return invalid(REFUND_MESSAGES.fullBalance);
      }
      return { ok: true, status: 'approved', amount: balance };
    }
    case 'standalone': {
      const amount = requestedAmount ?? input.currentAmount;
      if (amount <= 0n) return invalid(REFUND_MESSAGES.zeroBeforeWork);
      if (amount > balance) return invalid(REFUND_MESSAGES.exceeds);
      return { ok: true, status: 'approved', amount };
    }
  }
}

export type SecondApprovalPlan =
  { ok: true; status: 'rejected' | 'waived' | 'approved' } | RefundFailure;

/**
 * The Super admin step after work started (05 §5, §6.4). A zero amount is
 * `waived`, a positive one is `approved`, a rejection is `rejected`. The
 * balance is checked again because other refunds may have held money since
 * the first decision.
 */
export function planSecondApproval(input: {
  approve: boolean;
  reason: string;
  amount: bigint;
  balance: bigint;
}): SecondApprovalPlan {
  if (!input.reason.trim())
    return invalid(
      input.approve ? REFUND_MESSAGES.explainAmount : REFUND_MESSAGES.addReason,
    );
  if (!input.approve) return { ok: true, status: 'rejected' };
  if (input.amount > input.balance) return invalid(REFUND_MESSAGES.exceeds);
  return { ok: true, status: input.amount === 0n ? 'waived' : 'approved' };
}

/** Refund requester is never the decider (02 §6.14 rule 5, Q14). */
export function checkDecider(
  requestedBy: string,
  userId: string,
): RefundFailure | null {
  return requestedBy === userId ? forbidden(REFUND_MESSAGES.decider) : null;
}

/** The second approver is a Super admin and not the first decider (05 §5). */
export function checkSecondApprover(input: {
  decidedBy: string | null;
  userId: string;
  isSuperAdmin: boolean;
}): RefundFailure | null {
  if (!input.isSuperAdmin) return forbidden(REFUND_MESSAGES.secondRole);
  return input.decidedBy === input.userId
    ? forbidden(REFUND_MESSAGES.decider)
    : null;
}

/**
 * An offline refund is completed by someone who neither recorded the outgoing
 * transfer nor requested the refund (05 §6.4, 02 §6.14 rule 6).
 */
export function checkReconciler(input: {
  requestedBy: string;
  transferRecordedBy: string | null;
  userId: string;
}): RefundFailure | null {
  return input.transferRecordedBy === input.userId ||
    input.requestedBy === input.userId
    ? forbidden(REFUND_MESSAGES.reconciler)
    : null;
}

export type RequestPlan = { ok: true; amount: bigint } | RefundFailure;

/**
 * `refund.request` (05 §11). A refund raised for a cancellation before work
 * started is always the full balance, so an omitted amount becomes the
 * balance and any other amount is refused. After work started the amount may
 * be 0 up to the balance. Any other refund needs at least 1.
 */
export function planRefundRequest(input: {
  regime: RefundRegime;
  reason: string;
  requestedAmount: bigint | undefined;
  balance: bigint;
}): RequestPlan {
  if (!input.reason.trim()) return invalid(REFUND_MESSAGES.addReason);
  const { balance, requestedAmount } = input;
  if (balance <= 0n) return invalid(REFUND_MESSAGES.nothingLeft);
  if (requestedAmount !== undefined && requestedAmount > balance)
    return invalid(REFUND_MESSAGES.exceeds);
  switch (input.regime) {
    case 'before_work':
      if (requestedAmount !== undefined && requestedAmount < balance)
        return invalid(REFUND_MESSAGES.fullBalance);
      return { ok: true, amount: balance };
    case 'after_work':
      return { ok: true, amount: requestedAmount ?? balance };
    case 'standalone': {
      const amount = requestedAmount ?? balance;
      return amount <= 0n
        ? invalid(REFUND_MESSAGES.zeroBeforeWork)
        : { ok: true, amount };
    }
  }
}

export type GatewayRefundState = 'processed' | 'in_flight' | 'failed';

/**
 * Paystack refund statuses: `pending` and `processing` are on their way,
 * `processed` is done, `failed` and `needs-attention` need Finance. Anything
 * unrecognised is treated as in flight so it is never resubmitted by guess.
 */
export function classifyGatewayRefund(status: string): GatewayRefundState {
  const normal = status.toLowerCase();
  if (normal === 'processed') return 'processed';
  if (normal === 'failed' || normal === 'needs-attention') return 'failed';
  return 'in_flight';
}

/** A refund submitted to the gateway with no outcome recorded is left alone for this long before it may be resubmitted. */
export const RESUBMIT_COOLDOWN_MS = 2 * 60_000;

export const withinResubmitCooldown = (updatedAt: Date, now: Date): boolean =>
  now.getTime() - updatedAt.getTime() < RESUBMIT_COOLDOWN_MS;

export type CancellationRefundRow = {
  paymentId: string;
  status: string;
  createdAt: Date;
};

const SETTLED = new Set(['completed', 'waived']);
const OPEN = new Set([
  'pending_approval',
  'awaiting_second_approval',
  'approved',
  'processing',
]);

/**
 * 04 §5.2 #37: the cancellation can finish once every refund is completed or
 * validly waived. A rejected or failed refund that Finance has replaced does
 * not count: per payment, the newest refund decides, and nothing may still be
 * open. A cancellation with no refunds at all is not resolved.
 */
export function cancellationRefundsResolved(
  refunds: readonly CancellationRefundRow[],
): boolean {
  if (!refunds.length) return false;
  const byPayment = new Map<string, CancellationRefundRow[]>();
  for (const refund of refunds)
    byPayment.set(refund.paymentId, [
      ...(byPayment.get(refund.paymentId) ?? []),
      refund,
    ]);
  return [...byPayment.values()].every((group) => {
    if (group.some((refund) => OPEN.has(refund.status))) return false;
    const newest = group.reduce((latest, refund) =>
      refund.createdAt.getTime() >= latest.createdAt.getTime()
        ? refund
        : latest,
    );
    return SETTLED.has(newest.status);
  });
}
