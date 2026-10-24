/**
 * Africa/Lagos is UTC+1 all year, so WAT is computed as UTC plus a fixed
 * offset. The process time zone is never consulted.
 */
export const WAT_OFFSET_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/** 1970-01-01 (day index 0) was a Thursday. */
const WEEKDAY_BY_INDEX: Weekday[] = [
  'thu',
  'fri',
  'sat',
  'sun',
  'mon',
  'tue',
  'wed',
];

export type WatParts = {
  /** Days since 1970-01-01 in WAT. */
  dayIndex: number;
  date: string;
  weekday: Weekday;
  /** Minutes since WAT midnight; fractional when the instant has seconds. */
  minutes: number;
};

export function watParts(instant: Date): WatParts {
  const shifted = instant.getTime() + WAT_OFFSET_MS;
  const dayIndex = Math.floor(shifted / DAY_MS);
  return {
    dayIndex,
    date: dateOfDayIndex(dayIndex),
    weekday: weekdayOfDayIndex(dayIndex),
    minutes: (shifted - dayIndex * DAY_MS) / MINUTE_MS,
  };
}

export function weekdayOfDayIndex(dayIndex: number): Weekday {
  return WEEKDAY_BY_INDEX[((dayIndex % 7) + 7) % 7];
}

export function dateOfDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

export function dayIndexOfDate(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

/** The UTC instant at `minutes` past WAT midnight of the given day. */
export function instantAt(dayIndex: number, minutes: number): Date {
  return new Date(dayIndex * DAY_MS + minutes * MINUTE_MS - WAT_OFFSET_MS);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

/** 'HH:MM' to minutes since midnight. */
export function toMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}
