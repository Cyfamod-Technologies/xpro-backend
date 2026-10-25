import {
  intervalFits,
  type TimeOff,
  type WorkingHours,
} from '../../platform/calendar/provider-calendar';
import { watParts } from '../../platform/calendar/wat';
import { formatRequestId } from './statuses';

/** 04 §6.13 respond table, second-confirmation row. */
export const SECOND_CONFIRMATION_MESSAGE =
  'This date no longer works for the provider. XPro will propose a new one.';

export type ScheduleProviderCalendar = {
  workingHours: WorkingHours;
  timeOff: readonly TimeOff[];
  displayName: string;
};

export type ScheduleInterval = { startAt: Date; endAt: Date };

/** `HH:mm` on the WAT clock. */
function watClock(instant: Date): string {
  const minutes = Math.floor(watParts(instant).minutes);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The 04 §6.13 propose table below the status and standing rows, in order.
 * `overlap` is the interval of the conflicting appointment, if any; the
 * message quotes that appointment, not the proposed one.
 */
export function checkScheduleInterval(input: {
  startAt: Date;
  endAt: Date;
  now: Date;
  provider: ScheduleProviderCalendar;
  overlap: ScheduleInterval | null;
}): string | null {
  if (input.startAt <= input.now) return 'Choose a future date and time.';
  if (input.endAt <= input.startAt)
    return 'The end time must be after the start time.';
  if (input.endAt.getTime() > input.startAt.getTime() + 60 * 86_400_000)
    return 'Choose an end within 60 days of the start.';
  const calendarProblem = intervalFits(
    input.provider.workingHours,
    input.provider.timeOff,
    input.startAt,
    input.endAt,
    input.provider.displayName,
  );
  if (calendarProblem) return calendarProblem.message;
  if (input.overlap)
    return `This provider already has an appointment between ${watClock(input.overlap.startAt)} and ${watClock(input.overlap.endAt)}. Choose another time.`;
  return null;
}

/** 04 §6.13 "Provider hours or time off changed": the refusal for a confirmed job. The date is the WAT date. */
export function confirmedJobConflictMessage(
  startAt: Date,
  requestNumber: number,
): string {
  return `You have a confirmed job on ${watParts(startAt).date} (${formatRequestId(requestNumber)}). Ask XPro to move it before changing these hours.`;
}
