import {
  dateOfDayIndex,
  dayIndexOfDate,
  instantAt,
  isIsoDate,
  MINUTE_MS,
  toMinutes,
  watParts,
  Weekday,
  WEEKDAY_LABELS,
  weekdayOfDayIndex,
} from './wat';

export type { Weekday } from './wat';

/** 'HH:MM' in WAT. */
export type DayHours = { start: string; end: string };

/** Same shape as `provider_profiles.working_hours`; a missing or null day is a day off. */
export type WorkingHours = Partial<Record<Weekday, DayHours | null>>;

/** Same shape as an entry of `provider_profiles.time_off`; both dates inclusive. */
export type TimeOff = { id?: string; from: string; to: string; note?: string };

export type DayAvailability =
  | { available: true; start: string; end: string }
  | { available: false; reason: 'non_working_day' | 'time_off' };

export type IntervalProblemCode = 'weekday' | 'time_off' | 'outside_hours';

export type IntervalProblem = { code: IntervalProblemCode; message: string };

/** Longest stretch extendUntilWorkingMinutes will search before giving up. */
const MAX_SEARCH_DAYS = 366;

function dayHours(
  hours: WorkingHours,
  weekday: Weekday,
): { start: number; end: number } | null {
  const entry = hours?.[weekday];
  if (!entry) return null;
  const start = toMinutes(entry.start);
  const end = toMinutes(entry.end);
  return end > start ? { start, end } : null;
}

function isTimeOff(timeOff: readonly TimeOff[], date: string): boolean {
  return timeOff.some((entry) => entry.from <= date && date <= entry.to);
}

/** Working minutes in `[from, to)` after removing days off and time off. */
export function workingMinutesInWindow(
  hours: WorkingHours,
  timeOff: readonly TimeOff[],
  from: Date,
  to: Date,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const last = watParts(to).dayIndex;
  let totalMs = 0;
  for (let day = watParts(from).dayIndex; day <= last; day += 1) {
    const window = dayHours(hours, weekdayOfDayIndex(day));
    if (!window || isTimeOff(timeOff, dateOfDayIndex(day))) continue;
    const start = Math.max(
      from.getTime(),
      instantAt(day, window.start).getTime(),
    );
    const end = Math.min(to.getTime(), instantAt(day, window.end).getTime());
    if (end > start) totalMs += end - start;
  }
  return totalMs / MINUTE_MS;
}

/**
 * The instant at which `minMinutes` of the provider's working time, counted
 * from `from`, have elapsed (the end of the Nth working hour for N * 60).
 * When `until` is given the result is never earlier than it, which gives the
 * 04 §6.7 offer expiry: pass `offeredAt + 24 h` and 240 minutes. Returns null
 * when the provider has no such working time within a year.
 */
export function extendUntilWorkingMinutes(
  hours: WorkingHours,
  timeOff: readonly TimeOff[],
  from: Date,
  minMinutes: number,
  until?: Date,
): Date | null {
  const floor = until && until.getTime() > from.getTime() ? until : from;
  if (minMinutes <= 0) return floor;
  let remaining = minMinutes;
  const first = watParts(from).dayIndex;
  for (let day = first; day < first + MAX_SEARCH_DAYS; day += 1) {
    const window = dayHours(hours, weekdayOfDayIndex(day));
    if (!window || isTimeOff(timeOff, dateOfDayIndex(day))) continue;
    const open = Math.max(
      from.getTime(),
      instantAt(day, window.start).getTime(),
    );
    const close = instantAt(day, window.end).getTime();
    const available = (close - open) / MINUTE_MS;
    if (available <= 0) continue;
    if (remaining <= available) {
      const reached = new Date(open + remaining * MINUTE_MS);
      return reached.getTime() > floor.getTime() ? reached : floor;
    }
    remaining -= available;
  }
  return null;
}

export function dayAvailability(
  hours: WorkingHours,
  timeOff: readonly TimeOff[],
  isoDate: string,
): DayAvailability {
  if (!isIsoDate(isoDate))
    throw new RangeError(`Invalid ISO date: ${String(isoDate)}`);
  const day = dayIndexOfDate(isoDate);
  const window = dayHours(hours, weekdayOfDayIndex(day));
  if (!window) return { available: false, reason: 'non_working_day' };
  if (isTimeOff(timeOff, isoDate))
    return { available: false, reason: 'time_off' };
  const entry = hours[weekdayOfDayIndex(day)]!;
  return { available: true, start: entry.start, end: entry.end };
}

/**
 * Whether a proposed schedule interval fits the provider's weekly hours and
 * time off, with the exact failure of 04 §6.13. Checks in order: working day
 * (start day, then end day), time off on any date in the interval, then hours
 * (same day: both ends in that day's hours; multi-day: the start in the start
 * day's hours and the end in the end day's hours). Days in between only need
 * to be free of time off. Returns null when it fits.
 */
export function intervalFits(
  hours: WorkingHours,
  timeOff: readonly TimeOff[],
  startAt: Date,
  endAt: Date,
  provider: string,
): IntervalProblem | null {
  const start = watParts(startAt);
  const end = watParts(endAt);

  for (const part of start.dayIndex === end.dayIndex ? [start] : [start, end]) {
    if (!dayHours(hours, part.weekday))
      return {
        code: 'weekday',
        message: `${provider} doesn’t work on ${WEEKDAY_LABELS[part.weekday]}s.`,
      };
  }

  for (let day = start.dayIndex; day <= end.dayIndex; day += 1) {
    const date = dateOfDayIndex(day);
    if (isTimeOff(timeOff, date))
      return {
        code: 'time_off',
        message: `${provider} is on time off on ${date}.`,
      };
  }

  const startWindow = dayHours(hours, start.weekday)!;
  const endWindow = dayHours(hours, end.weekday)!;
  const startOk =
    start.minutes >= startWindow.start && start.minutes < startWindow.end;
  const endOk = end.minutes > endWindow.start && end.minutes <= endWindow.end;
  if (!startOk) return outsideHours(provider, start.weekday, startWindow);
  if (!endOk) return outsideHours(provider, end.weekday, endWindow);
  return null;
}

function outsideHours(
  provider: string,
  weekday: Weekday,
  window: { start: number; end: number },
): IntervalProblem {
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return {
    code: 'outside_hours',
    message: `This time is outside ${provider}’s working hours (${WEEKDAY_LABELS[weekday]} ${clock(window.start)}–${clock(window.end)}).`,
  };
}
