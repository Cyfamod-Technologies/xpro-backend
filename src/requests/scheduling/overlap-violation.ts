import { Prisma } from '@prisma/client';
import { AppError } from '../../platform/errors/app-error';
import { SECOND_CONFIRMATION_MESSAGE } from '../domain/schedule-checks';

const OVERLAP_CONSTRAINT = 'schedules_no_confirmed_overlap';
const EXCLUSION_VIOLATION = '23P01';

/**
 * True when `error` is Postgres rejecting a second `confirmed` schedule that
 * overlaps another one of the same provider (exclusion constraint
 * `schedules_no_confirmed_overlap`, SQLSTATE `23P01`). Prisma reports it as a
 * known error (raw queries, `meta`) or an unknown one (the code only appears
 * in the message), so both are inspected.
 */
export function isOverlapViolation(error: unknown): boolean {
  if (!(
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ))
    return false;
  const meta =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? JSON.stringify(error.meta ?? {})
      : '';
  const haystack = `${error.message}\n${meta}`;
  return (
    haystack.includes(EXCLUSION_VIOLATION) ||
    haystack.includes(OVERLAP_CONSTRAINT)
  );
}

/** Rethrows an overlap violation as the 04 §6.13 second-confirmation 409; any other error passes through. */
export function mapOverlapViolation(error: unknown): unknown {
  return isOverlapViolation(error)
    ? new AppError(409, 'STATE_CONFLICT', SECOND_CONFIRMATION_MESSAGE)
    : error;
}
