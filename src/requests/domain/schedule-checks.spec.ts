import { checkScheduleInterval } from './schedule-checks';

describe('checkScheduleInterval', () => {
  const provider = {
    displayName: 'Alex',
    workingHours: { monday: { start: '08:00', end: '17:00' } },
    timeOff: [],
  } as const;

  it('rejects invalid times in contract order', () => {
    const now = new Date('2026-10-26T06:00:00.000Z');
    expect(
      checkScheduleInterval({
        startAt: now,
        endAt: new Date(now.getTime() + 1),
        now,
        provider,
        overlaps: false,
      }),
    ).toBe('Choose a future date and time.');
    expect(
      checkScheduleInterval({
        startAt: new Date(now.getTime() + 1),
        endAt: now,
        now,
        provider,
        overlaps: false,
      }),
    ).toBe('The end time must be after the start time.');
  });

  it('validates the provider calendar and overlap result', () => {
    const now = new Date('2026-10-26T06:00:00.000Z');
    const startAt = new Date('2026-10-26T09:00:00.000Z');
    const endAt = new Date('2026-10-26T10:00:00.000Z');
    expect(
      checkScheduleInterval({ startAt, endAt, now, provider, overlaps: false }),
    ).toBeNull();
    expect(
      checkScheduleInterval({ startAt, endAt, now, provider, overlaps: true }),
    ).toContain('already has an appointment');
  });
});
