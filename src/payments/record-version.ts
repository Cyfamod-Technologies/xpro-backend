import { AppError } from '../platform/errors/app-error';

// new message: not in spec
export const RECORD_CHANGED_MESSAGE =
  'This record has changed. Refresh and retry.';

/** Refunds and payouts carry a `version` that every state change bumps (05 §11). A stale `If-Match` is refused; no header means no check. */
export function assertExpectedVersion(
  expected: number | undefined,
  actual: number,
): void {
  if (expected !== undefined && expected !== actual)
    throw new AppError(409, 'VERSION_CONFLICT', RECORD_CHANGED_MESSAGE);
}
