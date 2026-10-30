import { UnprocessableEntityException } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_LEAVE_DAYS = 90;

/** `YYYY-MM-DD` (or a full ISO string) to the WAT calendar date as UTC midnight. */
export function parseDateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Leave rules of spec 02 §6.9. `today` is the WAT calendar date as UTC midnight. */
export function validateLeaveWindow(from: Date, to: Date, today: Date): void {
  if (to < from)
    throw new UnprocessableEntityException(
      'The leave end date must be on or after the start date.',
    );
  if (from < today)
    throw new UnprocessableEntityException("Leave can't start in the past.");
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_LEAVE_DAYS)
    throw new UnprocessableEntityException(
      'Leave can be set for up to 90 days at a time.',
    );
}
