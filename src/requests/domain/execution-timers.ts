import { addWorkingMinutes } from '../../platform/calendar/business-calendar';

const DAY_MS = 86_400_000;

const DEFAULTS = {
  noShowGraceWorkingHours: 2,
  staleUpdateDays: 3,
  escalateDays: 5,
  blockedEscalateDays: 2,
} as const;

type Settings = Readonly<Record<string, unknown>>;

const positive = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/**
 * T13 (04 §8): `startAt` plus the no-show grace in business working hours
 * (`execution.noShowGraceWorkingHours`, Mon-Fri 08:00-18:00 WAT minus
 * `calendar.holidays`).
 */
export function noShowCheckDueAt(startAt: Date, settings: Settings): Date {
  const holidays = Array.isArray(settings['calendar.holidays'])
    ? settings['calendar.holidays'].filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const hours = positive(
    settings['execution.noShowGraceWorkingHours'],
    DEFAULTS.noShowGraceWorkingHours,
  );
  return addWorkingMinutes(startAt, hours * 60, holidays);
}

/** T15 reminder after an approved start, progress or resume update. */
export const staleUpdateDueAt = (now: Date, settings: Settings): Date =>
  new Date(
    now.getTime() +
      positive(
        settings['execution.staleUpdateDays'],
        DEFAULTS.staleUpdateDays,
      ) *
        DAY_MS,
  );

/** T15 escalation. */
export const staleEscalationDueAt = (now: Date, settings: Settings): Date =>
  new Date(
    now.getTime() +
      positive(settings['execution.escalateDays'], DEFAULTS.escalateDays) *
        DAY_MS,
  );

/** T16 review for an approved blocker or a staff hold. */
export const blockedReviewDueAt = (now: Date, settings: Settings): Date =>
  new Date(
    now.getTime() +
      positive(
        settings['execution.blockedEscalateDays'],
        DEFAULTS.blockedEscalateDays,
      ) *
        DAY_MS,
  );
