export const TIMER_MAX_ATTEMPTS = 5;

/** Wait after failed attempt 1..4; the fifth failure is final (plan C.9). */
export const TIMER_BACKOFF_MS = [1, 5, 15, 60].map((m) => m * 60_000);

/** A claimed row that is never finished becomes due again after this long. */
export const TIMER_CLAIM_LEASE_MS = 5 * 60_000;

export const TIMER_BATCH_SIZE = 50;

/** Safety cap on consecutive full batches in one sweep. */
export const TIMER_MAX_BATCHES = 20;

export const TIMERS_QUEUE = 'timers';
export const TIMER_FAILED_JOB_NAME = 'request.timer';
