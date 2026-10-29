import {
  blockedReviewDueAt,
  noShowCheckDueAt,
  staleEscalationDueAt,
  staleUpdateDueAt,
} from './execution-timers';

const iso = (date: Date) => date.toISOString();

describe('noShowCheckDueAt (04 §8 T13)', () => {
  it('adds the grace in working hours inside a working day', () => {
    // Mon 26 Oct 2026, 09:00 WAT.
    expect(iso(noShowCheckDueAt(new Date('2026-10-26T08:00:00Z'), {}))).toBe(
      '2026-10-26T10:00:00.000Z',
    );
  });

  it('carries the remainder over the weekend', () => {
    // Fri 30 Oct 17:00 WAT leaves one working hour; the other falls on Monday 09:00 WAT.
    expect(iso(noShowCheckDueAt(new Date('2026-10-30T16:00:00Z'), {}))).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('starts counting at the next opening when the job starts outside business hours', () => {
    // Sat 31 Oct 10:00 WAT -> Mon 08:00 WAT + 2 h = 10:00 WAT.
    expect(iso(noShowCheckDueAt(new Date('2026-10-31T09:00:00Z'), {}))).toBe(
      '2026-11-02T09:00:00.000Z',
    );
  });

  it('skips configured holidays', () => {
    expect(
      iso(
        noShowCheckDueAt(new Date('2026-10-30T16:00:00Z'), {
          'calendar.holidays': ['2026-11-02'],
        }),
      ),
    ).toBe('2026-11-03T08:00:00.000Z');
  });

  it('reads execution.noShowGraceWorkingHours', () => {
    expect(
      iso(
        noShowCheckDueAt(new Date('2026-10-26T08:00:00Z'), {
          'execution.noShowGraceWorkingHours': 4,
        }),
      ),
    ).toBe('2026-10-26T12:00:00.000Z');
  });

  it('falls back to two hours for a missing or invalid setting', () => {
    expect(
      iso(
        noShowCheckDueAt(new Date('2026-10-26T08:00:00Z'), {
          'execution.noShowGraceWorkingHours': 'x',
        }),
      ),
    ).toBe('2026-10-26T10:00:00.000Z');
  });
});

describe('T15 and T16 durations (04 §8)', () => {
  const now = new Date('2026-10-26T08:00:00Z');

  it('defaults to 3 days, 5 days and 2 days', () => {
    expect(iso(staleUpdateDueAt(now, {}))).toBe('2026-10-29T08:00:00.000Z');
    expect(iso(staleEscalationDueAt(now, {}))).toBe('2026-10-31T08:00:00.000Z');
    expect(iso(blockedReviewDueAt(now, {}))).toBe('2026-10-28T08:00:00.000Z');
  });

  it('reads the execution settings', () => {
    const settings = {
      'execution.staleUpdateDays': 1,
      'execution.escalateDays': 7,
      'execution.blockedEscalateDays': 4,
    };
    expect(iso(staleUpdateDueAt(now, settings))).toBe(
      '2026-10-27T08:00:00.000Z',
    );
    expect(iso(staleEscalationDueAt(now, settings))).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(iso(blockedReviewDueAt(now, settings))).toBe(
      '2026-10-30T08:00:00.000Z',
    );
  });
});
