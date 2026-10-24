import {
  intervalFits,
  type TimeOff,
  type WorkingHours,
} from '../../platform/calendar/provider-calendar';

export type ScheduleProviderCalendar = {
  workingHours: WorkingHours;
  timeOff: readonly TimeOff[];
  displayName: string;
};

export function checkScheduleInterval(input: {
  startAt: Date;
  endAt: Date;
  now: Date;
  provider: ScheduleProviderCalendar;
  overlaps: boolean;
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
  if (input.overlaps)
    return `This provider already has an appointment between ${input.startAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} and ${input.endAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}. Choose another time.`;
  return null;
}
