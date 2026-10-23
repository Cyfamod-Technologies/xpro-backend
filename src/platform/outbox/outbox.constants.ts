export const OUTBOX_EMAIL_NOTIFY = 'email.notify';

export const OUTBOX_MAX_ATTEMPTS = 5;

/** Wait after failed attempt 1..4; the fifth failure is final (plan C.9). */
export const OUTBOX_BACKOFF_MS = [1, 5, 15, 60].map((m) => m * 60_000);

/** A claimed row that is never finished becomes due again after this long. */
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60_000;

export const OUTBOX_BATCH_SIZE = 50;

export interface EmailNotifyPayload {
  recipientId: string;
  event: string;
  title: string;
  message: string;
  link?: string | null;
}
