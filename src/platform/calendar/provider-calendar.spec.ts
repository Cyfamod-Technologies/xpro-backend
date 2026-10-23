import {
  dayAvailability,
  extendUntilWorkingMinutes,
  intervalFits,
  TimeOff,
  WorkingHours,
  workingMinutesInWindow,
} from './provider-calendar';

const wat = (local: string) => new Date(`${local}:00+01:00`);
const iso = (d: Date | null) => d?.toISOString();

const weekdays8to17: WorkingHours = {
  mon: { start: '08:00', end: '17:00' },
  tue: { start: '08:00', end: '17:00' },
  wed: { start: '08:00', end: '17:00' },
  thu: { start: '08:00', end: '17:00' },
  fri: { start: '08:00', end: '17:00' },
  sat: null,
  sun: null,
};
const none: TimeOff[] = [];

describe('provider calendar', () => {
  describe('workingMinutesInWindow', () => {
    it('counts the provider’s hours inside the window', () => {
      expect(
        workingMinutesInWindow(
          weekdays8to17,
          none,
          wat('2026-10-21T07:00'),
          wat('2026-10-21T20:00'),
        ),
      ).toBe(540);
    });

    it('is 0 for a window with no working hours in it (Fri 18:00 + 24 h)', () => {
      expect(
        workingMinutesInWindow(
          weekdays8to17,
          none,
          wat('2026-10-23T18:00'),
          wat('2026-10-24T18:00'),
        ),
      ).toBe(0);
    });

    it('removes a time-off span and counts multiple days', () => {
      const off: TimeOff[] = [{ from: '2026-10-22', to: '2026-10-22' }];
      expect(
        workingMinutesInWindow(
          weekdays8to17,
          off,
          wat('2026-10-21T00:00'),
          wat('2026-10-24T00:00'),
        ),
      ).toBe(540 * 2);
    });

    it('treats a missing day as a day off', () => {
      expect(
        workingMinutesInWindow(
          { mon: { start: '09:00', end: '10:00' } },
          none,
          wat('2026-10-19T00:00'),
          wat('2026-10-26T00:00'),
        ),
      ).toBe(60);
    });
  });

  describe('extendUntilWorkingMinutes', () => {
    it('04 §6.7: Fri 18:00 offer, 24 h window, 4 working hours expires Mon 12:00', () => {
      const offeredAt = wat('2026-10-23T18:00');
      const base = new Date(offeredAt.getTime() + 24 * 3_600_000);
      expect(
        iso(
          extendUntilWorkingMinutes(weekdays8to17, none, offeredAt, 240, base),
        ),
      ).toBe(iso(wat('2026-10-26T12:00')));
    });

    it('keeps the 24 h expiry when the window already holds enough hours', () => {
      const offeredAt = wat('2026-10-21T09:00');
      const base = new Date(offeredAt.getTime() + 24 * 3_600_000);
      expect(
        iso(
          extendUntilWorkingMinutes(weekdays8to17, none, offeredAt, 240, base),
        ),
      ).toBe(iso(base));
    });

    it('reaches the end of the 4th hour when it falls after the base end', () => {
      const offeredAt = wat('2026-10-21T16:00');
      const base = new Date(offeredAt.getTime() + 60 * 60_000);
      expect(
        iso(
          extendUntilWorkingMinutes(weekdays8to17, none, offeredAt, 240, base),
        ),
      ).toBe(iso(wat('2026-10-22T11:00')));
    });

    it('skips time off', () => {
      const off: TimeOff[] = [{ from: '2026-10-26', to: '2026-10-27' }];
      expect(
        iso(
          extendUntilWorkingMinutes(
            weekdays8to17,
            off,
            wat('2026-10-23T18:00'),
            240,
          ),
        ),
      ).toBe(iso(wat('2026-10-28T12:00')));
    });

    it('spans several days when the minimum is large', () => {
      expect(
        iso(
          extendUntilWorkingMinutes(
            weekdays8to17,
            none,
            wat('2026-10-21T08:00'),
            540 * 2 + 60,
          ),
        ),
      ).toBe(iso(wat('2026-10-23T09:00')));
    });

    it('returns null when the provider never works', () => {
      expect(
        extendUntilWorkingMinutes({}, none, wat('2026-10-21T08:00'), 60),
      ).toBeNull();
    });
  });

  describe('dayAvailability', () => {
    const off: TimeOff[] = [{ from: '2026-10-21', to: '2026-10-22' }];

    it('reports the hours of a working day', () => {
      expect(dayAvailability(weekdays8to17, off, '2026-10-23')).toEqual({
        available: true,
        start: '08:00',
        end: '17:00',
      });
    });

    it('reports a non-working weekday before time off', () => {
      expect(dayAvailability(weekdays8to17, off, '2026-10-24')).toEqual({
        available: false,
        reason: 'non_working_day',
      });
    });

    it('reports time off, inclusive of both ends', () => {
      for (const date of ['2026-10-21', '2026-10-22'])
        expect(dayAvailability(weekdays8to17, off, date)).toEqual({
          available: false,
          reason: 'time_off',
        });
    });

    it('rejects a malformed date', () => {
      expect(() => dayAvailability(weekdays8to17, off, '21/10/2026')).toThrow(
        RangeError,
      );
    });
  });

  describe('intervalFits', () => {
    const fits = (startAt: string, endAt: string, timeOff: TimeOff[] = none) =>
      intervalFits(
        weekdays8to17,
        timeOff,
        wat(startAt),
        wat(endAt),
        'Ada Builders',
      );

    it('accepts a same-day interval inside the hours, up to closing time', () => {
      expect(fits('2026-10-21T08:00', '2026-10-21T17:00')).toBeNull();
    });

    it('rejects a non-working weekday', () => {
      expect(fits('2026-10-24T09:00', '2026-10-24T11:00')).toEqual({
        code: 'weekday',
        message: 'Ada Builders doesn’t work on Saturdays.',
      });
    });

    it('rejects time off on any date in the interval', () => {
      const off: TimeOff[] = [{ from: '2026-10-22', to: '2026-10-22' }];
      expect(fits('2026-10-21T09:00', '2026-10-23T11:00', off)).toEqual({
        code: 'time_off',
        message: 'Ada Builders is on time off on 2026-10-22.',
      });
    });

    it('rejects a same-day interval that starts too early or ends too late', () => {
      const message =
        'This time is outside Ada Builders’s working hours (Wednesday 08:00–17:00).';
      expect(fits('2026-10-21T07:00', '2026-10-21T10:00')).toEqual({
        code: 'outside_hours',
        message,
      });
      expect(fits('2026-10-21T15:00', '2026-10-21T17:30')).toEqual({
        code: 'outside_hours',
        message,
      });
    });

    it('accepts a multi-day interval whose ends sit inside their days’ hours', () => {
      expect(fits('2026-10-21T09:00', '2026-10-23T16:00')).toBeNull();
    });

    it('checks the start against the start day and the end against the end day', () => {
      expect(fits('2026-10-21T17:00', '2026-10-23T16:00')).toEqual({
        code: 'outside_hours',
        message:
          'This time is outside Ada Builders’s working hours (Wednesday 08:00–17:00).',
      });
      expect(fits('2026-10-21T09:00', '2026-10-23T18:00')).toEqual({
        code: 'outside_hours',
        message:
          'This time is outside Ada Builders’s working hours (Friday 08:00–17:00).',
      });
    });

    it('lets a multi-day interval cross a weekend but not end on one', () => {
      expect(fits('2026-10-23T09:00', '2026-10-26T12:00')).toBeNull();
      expect(fits('2026-10-23T09:00', '2026-10-25T12:00')).toEqual({
        code: 'weekday',
        message: 'Ada Builders doesn’t work on Sundays.',
      });
    });
  });
});
