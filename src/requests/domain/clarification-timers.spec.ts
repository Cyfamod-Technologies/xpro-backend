import {
  clarificationAutoCancelDays,
  clarificationDueTimes,
} from './clarification-timers';

const askedAt = new Date('2026-10-01T10:00:00.000Z');
const iso = (date: Date | null) => date?.toISOString();

describe('clarificationDueTimes', () => {
  it('uses the registry defaults when no setting is stored (48 h, 5 days, 14 days)', () => {
    const due = clarificationDueTimes(askedAt, {});
    expect(iso(due.reminderAt)).toBe('2026-10-03T10:00:00.000Z');
    expect(iso(due.staffItemAt)).toBe('2026-10-06T10:00:00.000Z');
    expect(iso(due.finalWarningAt)).toBe('2026-10-14T10:00:00.000Z');
    expect(iso(due.autoCancelAt)).toBe('2026-10-15T10:00:00.000Z');
  });

  it('follows the clarification settings and warns 24 h before auto-cancel', () => {
    const due = clarificationDueTimes(askedAt, {
      'clarification.reminderHours': 6,
      'clarification.escalateDays': 2,
      'clarification.autoCancelDays': 7,
    });
    expect(iso(due.reminderAt)).toBe('2026-10-01T16:00:00.000Z');
    expect(iso(due.staffItemAt)).toBe('2026-10-03T10:00:00.000Z');
    expect(iso(due.finalWarningAt)).toBe('2026-10-07T10:00:00.000Z');
    expect(iso(due.autoCancelAt)).toBe('2026-10-08T10:00:00.000Z');
  });

  it('skips the final warning when auto-cancel is 24 h or less after the question', () => {
    expect(
      clarificationDueTimes(askedAt, { 'clarification.autoCancelDays': 1 })
        .finalWarningAt,
    ).toBeNull();
  });

  it('ignores values that are not positive numbers', () => {
    const due = clarificationDueTimes(askedAt, {
      'clarification.reminderHours': 'soon',
      'clarification.escalateDays': 0,
      'clarification.autoCancelDays': null,
    });
    expect(iso(due.reminderAt)).toBe('2026-10-03T10:00:00.000Z');
    expect(iso(due.staffItemAt)).toBe('2026-10-06T10:00:00.000Z');
    expect(clarificationAutoCancelDays({})).toBe(14);
  });
});
