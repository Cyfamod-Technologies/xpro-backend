import {
  isFreshPendingAttempt,
  newestPendingAttempt,
  pendingCheckDueAt,
} from './pending-attempt';

const now = new Date('2026-10-25T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('pending attempt rule', () => {
  it('is fresh for under 30 minutes and stale from 30 minutes on', () => {
    expect(isFreshPendingAttempt(minutesAgo(0), now)).toBe(true);
    expect(isFreshPendingAttempt(minutesAgo(29.9), now)).toBe(true);
    expect(isFreshPendingAttempt(minutesAgo(30), now)).toBe(false);
    expect(isFreshPendingAttempt(minutesAgo(31), now)).toBe(false);
  });

  it('is not fresh without an attempt', () => {
    expect(isFreshPendingAttempt(null, now)).toBe(false);
    expect(isFreshPendingAttempt(undefined, now)).toBe(false);
  });

  it('picks the newest pending Paystack attempt only', () => {
    expect(
      newestPendingAttempt([
        { status: 'pending', method: 'paystack', createdAt: minutesAgo(50) },
        { status: 'pending', method: 'paystack', createdAt: minutesAgo(10) },
        { status: 'failed', method: 'paystack', createdAt: minutesAgo(1) },
        { status: 'recorded', method: 'offline', createdAt: minutesAgo(2) },
      ]),
    ).toEqual(minutesAgo(10));
    expect(newestPendingAttempt([])).toBeNull();
  });

  it('schedules the check 30 minutes after the attempt', () => {
    expect(pendingCheckDueAt(now)).toEqual(new Date('2026-10-25T10:30:00Z'));
  });
});
