const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ClarificationDueTimes = {
  reminderAt: Date;
  staffItemAt: Date;
  /** `null` when auto-cancel is 24 h or less after the question, so there is no earlier moment to warn at. */
  finalWarningAt: Date | null;
  autoCancelAt: Date;
};

/** Setting defaults match `settings.registry.ts` (04 §4.10). */
const DEFAULTS = {
  reminderHours: 48,
  escalateDays: 5,
  autoCancelDays: 14,
} as const;

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function clarificationAutoCancelDays(
  settings: Readonly<Record<string, unknown>>,
): number {
  return positive(
    settings['clarification.autoCancelDays'],
    DEFAULTS.autoCancelDays,
  );
}

/** T6 due times for a clarification asked at `askedAt` (04 §6.4): reminder, staff item, final warning 24 h before auto-cancel, auto-cancel. */
export function clarificationDueTimes(
  askedAt: Date,
  settings: Readonly<Record<string, unknown>>,
): ClarificationDueTimes {
  const reminderHours = positive(
    settings['clarification.reminderHours'],
    DEFAULTS.reminderHours,
  );
  const escalateDays = positive(
    settings['clarification.escalateDays'],
    DEFAULTS.escalateDays,
  );
  const start = askedAt.getTime();
  const autoCancelAt = new Date(
    start + clarificationAutoCancelDays(settings) * DAY_MS,
  );
  const finalWarning = autoCancelAt.getTime() - DAY_MS;
  return {
    reminderAt: new Date(start + reminderHours * HOUR_MS),
    staffItemAt: new Date(start + escalateDays * DAY_MS),
    finalWarningAt: finalWarning > start ? new Date(finalWarning) : null,
    autoCancelAt,
  };
}
