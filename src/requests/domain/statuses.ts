export const REQUEST_STATUSES = [
  'submitted',
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
  'cancelling',
  'closed',
  'cancelled',
  'rejected',
  'approved',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TERMINAL: ReadonlySet<RequestStatus> = new Set([
  'closed',
  'cancelled',
  'rejected',
  'approved',
]);

export const FROZEN: ReadonlySet<RequestStatus> = new Set([
  'acknowledged',
  'cancelling',
]);

export function isOpen(status: RequestStatus): boolean {
  return !TERMINAL.has(status);
}

export function formatRequestId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('Request sequence must be a positive safe integer.');
  }

  return `XPR-${String(sequence).padStart(5, '0')}`;
}

export function parseRequestId(value: string): number | null {
  const match = /^XPR-(\d{5,})$/.exec(value);
  if (!match) return null;

  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
