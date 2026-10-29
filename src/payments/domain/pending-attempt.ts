export const PENDING_ATTEMPT_WINDOW_MS = 30 * 60_000;

/** 05 §6.1: a Paystack attempt younger than 30 minutes blocks a second checkout and the T9 lapse. */
export function isFreshPendingAttempt(
  createdAt: Date | null | undefined,
  now: Date,
): boolean {
  return (
    !!createdAt &&
    now.getTime() - createdAt.getTime() < PENDING_ATTEMPT_WINDOW_MS
  );
}

export type AttemptRow = { status: string; method: string; createdAt: Date };

/** The newest `pending` Paystack attempt, which is the one that can still be charged. */
export function newestPendingAttempt(
  payments: readonly AttemptRow[],
): Date | null {
  const dates = payments
    .filter((p) => p.status === 'pending' && p.method === 'paystack')
    .map((p) => p.createdAt.getTime());
  return dates.length ? new Date(Math.max(...dates)) : null;
}

/** When the 30-minute check (and a deferred T9 lapse) should run for an attempt. */
export const pendingCheckDueAt = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + PENDING_ATTEMPT_WINDOW_MS);
