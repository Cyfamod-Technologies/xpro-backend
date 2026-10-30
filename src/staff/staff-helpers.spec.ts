import { UnprocessableEntityException } from '@nestjs/common';
import {
  isOnLeave,
  resolveDestinations,
  watToday,
} from './staff-handover.service';
import { parseDateOnly, validateLeaveWindow } from './staff-leave';
import { parseIfMatch } from './staff-version';

describe('resolveDestinations', () => {
  it('needs nothing when the member owns nothing', () => {
    expect(resolveDestinations([], undefined)).toEqual(new Map());
  });

  it('sends everything to one place with `all`', () => {
    const result = resolveDestinations(['a', 'b'], { all: 'queue' });
    expect(result).toEqual(
      new Map([
        ['a', 'queue'],
        ['b', 'queue'],
      ]),
    );
  });

  it('accepts a per-request list that covers every request', () => {
    const result = resolveDestinations(['a', 'b'], {
      items: [
        { requestId: 'a', to: 'staff-1' },
        { requestId: 'b', to: 'queue' },
      ],
    });
    expect(result).toEqual(
      new Map([
        ['a', 'staff-1'],
        ['b', 'queue'],
      ]),
    );
  });

  it('reports missing when a request has no destination', () => {
    expect(
      resolveDestinations(['a', 'b'], {
        items: [{ requestId: 'a', to: 'queue' }],
      }),
    ).toBe('missing');
    expect(resolveDestinations(['a'], undefined)).toBe('missing');
  });
});

describe('leave rules', () => {
  const today = parseDateOnly('2026-11-02');

  it('accepts a window that starts today', () => {
    expect(() =>
      validateLeaveWindow(today, parseDateOnly('2026-11-12'), today),
    ).not.toThrow();
  });

  it('rejects an end before the start', () => {
    expect(() =>
      validateLeaveWindow(today, parseDateOnly('2026-11-01'), today),
    ).toThrow('The leave end date must be on or after the start date.');
  });

  it('rejects a start in the past', () => {
    expect(() =>
      validateLeaveWindow(
        parseDateOnly('2026-11-01'),
        parseDateOnly('2026-11-05'),
        today,
      ),
    ).toThrow(UnprocessableEntityException);
  });

  it('allows exactly 90 days and rejects 91', () => {
    expect(() =>
      validateLeaveWindow(today, parseDateOnly('2027-01-30'), today),
    ).not.toThrow();
    expect(() =>
      validateLeaveWindow(today, parseDateOnly('2027-01-31'), today),
    ).toThrow('Leave can be set for up to 90 days at a time.');
  });

  it('knows who is on leave on a given day', () => {
    const member = {
      leaveFrom: parseDateOnly('2026-11-02'),
      leaveTo: parseDateOnly('2026-11-04'),
    };
    expect(isOnLeave(member, parseDateOnly('2026-11-02'))).toBe(true);
    expect(isOnLeave(member, parseDateOnly('2026-11-04'))).toBe(true);
    expect(isOnLeave(member, parseDateOnly('2026-11-05'))).toBe(false);
    expect(isOnLeave({ leaveFrom: null, leaveTo: null }, today)).toBe(false);
  });

  it('uses the WAT calendar date', () => {
    // 23:30 UTC is already the next day in Lagos.
    expect(watToday(new Date('2026-11-01T23:30:00.000Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});

describe('parseIfMatch', () => {
  it('reads plain, quoted and weak versions', () => {
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"3"')).toBe(3);
  });

  it('treats a missing header as no check', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('  ')).toBeUndefined();
  });

  it('rejects anything else', () => {
    expect(() => parseIfMatch('abc')).toThrow();
  });
});
