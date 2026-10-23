import {
  addWorkingMinutes,
  nextWorkingMinute,
  workingMinutesBetween,
} from './business-calendar';

const wat = (local: string) => new Date(`${local}:00+01:00`);
const iso = (d: Date) => d.toISOString();

describe('business calendar (Mon-Fri 08:00-18:00 WAT)', () => {
  describe('nextWorkingMinute', () => {
    it('keeps an instant that is inside working time', () => {
      const t = wat('2026-10-23T10:30');
      expect(iso(nextWorkingMinute(t))).toBe(iso(t));
    });

    it('moves an early morning instant to 08:00 the same day', () => {
      expect(iso(nextWorkingMinute(wat('2026-10-23T06:00')))).toBe(
        iso(wat('2026-10-23T08:00')),
      );
    });

    it('treats 18:00 as closed and moves to the next working day', () => {
      expect(iso(nextWorkingMinute(wat('2026-10-22T18:00')))).toBe(
        iso(wat('2026-10-23T08:00')),
      );
    });

    it('skips the weekend', () => {
      expect(iso(nextWorkingMinute(wat('2026-10-23T18:00')))).toBe(
        iso(wat('2026-10-26T08:00')),
      );
      expect(iso(nextWorkingMinute(wat('2026-10-24T11:00')))).toBe(
        iso(wat('2026-10-26T08:00')),
      );
    });

    it('skips holidays', () => {
      expect(
        iso(nextWorkingMinute(wat('2026-10-23T18:00'), ['2026-10-26'])),
      ).toBe(iso(wat('2026-10-27T08:00')));
    });

    it('reads the WAT date, not the UTC date', () => {
      // 23:30 UTC on Thursday is 00:30 WAT on Friday.
      const t = new Date('2026-10-22T23:30:00Z');
      expect(iso(nextWorkingMinute(t))).toBe(iso(wat('2026-10-23T08:00')));
    });
  });

  describe('addWorkingMinutes', () => {
    it('adds within one day', () => {
      expect(iso(addWorkingMinutes(wat('2026-10-21T09:00'), 120))).toBe(
        iso(wat('2026-10-21T11:00')),
      );
    });

    it('returns 18:00 when the last minute is the last of the day', () => {
      expect(iso(addWorkingMinutes(wat('2026-10-21T16:00'), 120))).toBe(
        iso(wat('2026-10-21T18:00')),
      );
    });

    it('rolls over to the next morning', () => {
      expect(iso(addWorkingMinutes(wat('2026-10-21T16:00'), 180))).toBe(
        iso(wat('2026-10-22T09:00')),
      );
    });

    it('starts the clock at the next working minute', () => {
      expect(iso(addWorkingMinutes(wat('2026-10-23T19:30'), 240))).toBe(
        iso(wat('2026-10-26T12:00')),
      );
      expect(iso(addWorkingMinutes(wat('2026-10-24T09:00'), 0))).toBe(
        iso(wat('2026-10-26T08:00')),
      );
    });

    it('treats one working day as 10 hours', () => {
      expect(iso(addWorkingMinutes(wat('2026-10-21T08:00'), 600))).toBe(
        iso(wat('2026-10-21T18:00')),
      );
      expect(iso(addWorkingMinutes(wat('2026-10-21T08:00'), 1200))).toBe(
        iso(wat('2026-10-22T18:00')),
      );
    });

    it('crosses a weekend and a holiday', () => {
      expect(
        iso(addWorkingMinutes(wat('2026-10-23T16:00'), 180, ['2026-10-26'])),
      ).toBe(iso(wat('2026-10-27T09:00')));
    });

    it('does not use the process time zone', () => {
      const original = process.env.TZ;
      process.env.TZ = 'America/Los_Angeles';
      try {
        expect(iso(addWorkingMinutes(wat('2026-10-21T09:00'), 60))).toBe(
          iso(wat('2026-10-21T10:00')),
        );
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });

    it('rejects negative minutes', () => {
      expect(() => addWorkingMinutes(wat('2026-10-21T09:00'), -1)).toThrow(
        RangeError,
      );
    });
  });

  describe('workingMinutesBetween', () => {
    it('counts inside one day', () => {
      expect(
        workingMinutesBetween(wat('2026-10-21T09:00'), wat('2026-10-21T11:30')),
      ).toBe(150);
    });

    it('clips to working time', () => {
      expect(
        workingMinutesBetween(wat('2026-10-21T06:00'), wat('2026-10-21T20:00')),
      ).toBe(600);
    });

    it('excludes weekends', () => {
      expect(
        workingMinutesBetween(wat('2026-10-23T16:00'), wat('2026-10-26T10:00')),
      ).toBe(240);
    });

    it('excludes holidays', () => {
      expect(
        workingMinutesBetween(
          wat('2026-10-23T16:00'),
          wat('2026-10-27T10:00'),
          ['2026-10-26'],
        ),
      ).toBe(240);
    });

    it('is zero for an empty or reversed range, or one outside working time', () => {
      const a = wat('2026-10-21T10:00');
      expect(workingMinutesBetween(a, a)).toBe(0);
      expect(workingMinutesBetween(a, wat('2026-10-21T09:00'))).toBe(0);
      expect(
        workingMinutesBetween(wat('2026-10-24T09:00'), wat('2026-10-25T17:00')),
      ).toBe(0);
    });

    it('agrees with addWorkingMinutes', () => {
      const start = wat('2026-10-22T15:20');
      const end = addWorkingMinutes(start, 1337, ['2026-10-26']);
      expect(workingMinutesBetween(start, end, ['2026-10-26'])).toBe(1337);
    });
  });
});
