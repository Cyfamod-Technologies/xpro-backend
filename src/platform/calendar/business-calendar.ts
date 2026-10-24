import {
  dateOfDayIndex,
  instantAt,
  MINUTE_MS,
  watParts,
  weekdayOfDayIndex,
} from './wat';

/** Business time: Monday to Friday, 08:00-18:00 WAT, minus public holidays (06 §6.1). */
export const BUSINESS_DAY_START_MINUTES = 8 * 60;
export const BUSINESS_DAY_END_MINUTES = 18 * 60;
export const WORKING_MINUTES_PER_DAY =
  BUSINESS_DAY_END_MINUTES - BUSINESS_DAY_START_MINUTES;

/** ISO dates (`YYYY-MM-DD`, WAT) from the `calendar.holidays` setting. */
export type Holidays = ReadonlySet<string> | readonly string[];

/** Longest run of consecutive non-working days a search will cross. */
const MAX_SEARCH_DAYS = 4_000;

const toSet = (holidays: Holidays): ReadonlySet<string> =>
  holidays instanceof Set ? holidays : new Set(holidays);

function isWorkingDay(dayIndex: number, holidays: ReadonlySet<string>) {
  const weekday = weekdayOfDayIndex(dayIndex);
  return (
    weekday !== 'sat' &&
    weekday !== 'sun' &&
    !holidays.has(dateOfDayIndex(dayIndex))
  );
}

/**
 * `t` itself when it falls inside working time, otherwise the next opening
 * (08:00 WAT on the next working day). 18:00 sharp is already outside.
 */
export function nextWorkingMinute(t: Date, holidays: Holidays = []): Date {
  const set = toSet(holidays);
  const ms = t.getTime();
  const first = watParts(t).dayIndex;
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset += 1) {
    const day = first + offset;
    if (!isWorkingDay(day, set)) continue;
    if (ms < instantAt(day, BUSINESS_DAY_START_MINUTES).getTime())
      return instantAt(day, BUSINESS_DAY_START_MINUTES);
    if (ms < instantAt(day, BUSINESS_DAY_END_MINUTES).getTime())
      return new Date(ms);
  }
  throw new RangeError('No working day found within the search horizon.');
}

/**
 * Moves forward by `minutes` of working time. A start outside working time
 * first moves to the next working minute. When the last minute is the last of
 * a day, the result is that day's 18:00 (the end of the window), not the next
 * morning.
 */
export function addWorkingMinutes(
  start: Date,
  minutes: number,
  holidays: Holidays = [],
): Date {
  if (!Number.isFinite(minutes) || minutes < 0)
    throw new RangeError('minutes must be a non-negative number.');
  const set = toSet(holidays);
  let current = nextWorkingMinute(start, set).getTime();
  let remaining = minutes;
  for (let guard = 0; guard < MAX_SEARCH_DAYS; guard += 1) {
    const close = instantAt(
      watParts(new Date(current)).dayIndex,
      BUSINESS_DAY_END_MINUTES,
    ).getTime();
    const available = (close - current) / MINUTE_MS;
    if (remaining <= available)
      return new Date(current + remaining * MINUTE_MS);
    remaining -= available;
    current = nextWorkingMinute(new Date(close), set).getTime();
  }
  throw new RangeError('Working time exhausted within the search horizon.');
}

/** Working minutes in `[a, b)`; 0 when `b <= a`. */
export function workingMinutesBetween(
  a: Date,
  b: Date,
  holidays: Holidays = [],
): number {
  if (b.getTime() <= a.getTime()) return 0;
  const set = toSet(holidays);
  const last = watParts(b).dayIndex;
  let totalMs = 0;
  for (let day = watParts(a).dayIndex; day <= last; day += 1) {
    if (!isWorkingDay(day, set)) continue;
    const from = Math.max(
      a.getTime(),
      instantAt(day, BUSINESS_DAY_START_MINUTES).getTime(),
    );
    const to = Math.min(
      b.getTime(),
      instantAt(day, BUSINESS_DAY_END_MINUTES).getTime(),
    );
    if (to > from) totalMs += to - from;
  }
  return totalMs / MINUTE_MS;
}
