import { AppError } from '../platform/errors/app-error';

/**
 * Reads the staff `rowVersion` from an `If-Match` header (`"3"`, `W/"3"` or `3`).
 * A missing header means "no concurrency check"; a malformed one is rejected.
 */
export function parseIfMatch(header?: string): number | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!match)
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Send the staff member version in If-Match.',
    );
  return Number(match[1]);
}
