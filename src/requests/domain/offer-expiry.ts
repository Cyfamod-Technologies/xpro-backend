import {
  extendUntilWorkingMinutes,
  type TimeOff,
  type WorkingHours,
} from '../../platform/calendar/provider-calendar';

export function offerExpiry(
  offeredAt: Date,
  hours: number,
  minWorkingHours: number,
  workingHours: WorkingHours,
  timeOff: readonly TimeOff[],
): Date {
  const baseline = new Date(offeredAt.getTime() + hours * 60 * 60 * 1000);
  if (minWorkingHours <= 0) return baseline;
  return (
    extendUntilWorkingMinutes(
      workingHours,
      timeOff,
      offeredAt,
      minWorkingHours * 60,
      baseline,
    ) ?? baseline
  );
}
