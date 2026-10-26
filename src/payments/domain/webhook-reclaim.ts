/** Status values of `gateway_events.status`. */
export const GatewayEventStatus = {
  processing: 'processing',
  processed: 'processed',
  ignored: 'ignored',
  failed: 'failed',
  quarantined: 'quarantined',
  deadLetter: 'dead_letter',
} as const;

export const GATEWAY_EVENT_MAX_ATTEMPTS = 8;

/** A `processing` row nobody finished becomes claimable again after this long. */
export const GATEWAY_EVENT_LEASE_MS = 5 * 60_000;

/** Wait after failed attempt 1..7; the eighth failure dead-letters the event. */
export const GATEWAY_EVENT_BACKOFF_MS = [1, 5, 15, 60, 180, 360, 720].map(
  (minutes) => minutes * 60_000,
);

/** Events that never run again, however often the sender redelivers them. */
const FINAL = new Set<string>([
  GatewayEventStatus.processed,
  GatewayEventStatus.ignored,
  GatewayEventStatus.quarantined,
  GatewayEventStatus.deadLetter,
]);

export type InboxRow = {
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  receivedAt: Date;
};

/**
 * - `duplicate`: acknowledge, nothing to do.
 * - `in_flight`: another worker holds a live lease; acknowledge.
 * - `backoff`: a sweeper found it before its retry time.
 * - `reclaim`: run it again (`stale` when a crashed worker left it `processing`).
 * - `dead_letter`: attempts are used up; raise the alert.
 */
export type ReclaimDecision =
  | { action: 'duplicate' | 'in_flight' | 'backoff' | 'dead_letter' }
  | { action: 'reclaim'; stale: boolean };

/**
 * 05 §8 "Gateway inbox retry": what to do with an event we already have.
 * `redelivery` is Paystack sending the same signed body again, which is its
 * own backoff, so a failed row is reclaimed straight away. The `sweeper` waits
 * for `nextAttemptAt`.
 */
export function decideReclaim(
  row: InboxRow,
  now: Date,
  source: 'redelivery' | 'sweeper',
): ReclaimDecision {
  if (FINAL.has(row.status)) return { action: 'duplicate' };
  if (row.status === GatewayEventStatus.failed) {
    if (row.attempts >= GATEWAY_EVENT_MAX_ATTEMPTS)
      return { action: 'dead_letter' };
    if (source === 'sweeper' && row.nextAttemptAt && row.nextAttemptAt > now)
      return { action: 'backoff' };
    return { action: 'reclaim', stale: false };
  }
  const leaseEnd =
    row.nextAttemptAt ??
    new Date(row.receivedAt.getTime() + GATEWAY_EVENT_LEASE_MS);
  if (leaseEnd > now) return { action: 'in_flight' };
  if (row.attempts + 1 >= GATEWAY_EVENT_MAX_ATTEMPTS)
    return { action: 'dead_letter' };
  return { action: 'reclaim', stale: true };
}

export type FailureOutcome = {
  status: 'failed' | 'dead_letter';
  nextAttemptAt: Date | null;
};

/** The row's state after its `attemptsAfter`-th failure. */
export function failureOutcome(
  attemptsAfter: number,
  now: Date,
): FailureOutcome {
  if (attemptsAfter >= GATEWAY_EVENT_MAX_ATTEMPTS)
    return { status: 'dead_letter', nextAttemptAt: null };
  const wait =
    GATEWAY_EVENT_BACKOFF_MS[
      Math.min(attemptsAfter, GATEWAY_EVENT_BACKOFF_MS.length) - 1
    ];
  return {
    status: 'failed',
    nextAttemptAt: new Date(now.getTime() + wait),
  };
}
