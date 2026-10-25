import {
  GATEWAY_EVENT_BACKOFF_MS,
  GATEWAY_EVENT_LEASE_MS,
  GATEWAY_EVENT_MAX_ATTEMPTS,
  decideReclaim,
  failureOutcome,
} from './webhook-reclaim';

const now = new Date('2026-10-25T10:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const row = (overrides: Partial<Parameters<typeof decideReclaim>[0]> = {}) => ({
  status: 'processing',
  attempts: 0,
  nextAttemptAt: null as Date | null,
  receivedAt: now,
  ...overrides,
});

describe('decideReclaim', () => {
  it.each(['processed', 'ignored', 'quarantined', 'dead_letter'])(
    'acknowledges a %s event without running it again',
    (status) => {
      expect(decideReclaim(row({ status }), now, 'redelivery')).toEqual({
        action: 'duplicate',
      });
      expect(decideReclaim(row({ status }), now, 'sweeper')).toEqual({
        action: 'duplicate',
      });
    },
  );

  it('reclaims a failed event when the sender redelivers it, even before its retry time', () => {
    expect(
      decideReclaim(
        row({ status: 'failed', attempts: 2, nextAttemptAt: at(60_000) }),
        now,
        'redelivery',
      ),
    ).toEqual({ action: 'reclaim', stale: false });
  });

  it('makes the sweeper wait for the retry time, then reclaims', () => {
    const failed = row({ status: 'failed', attempts: 1, nextAttemptAt: at(1) });
    expect(decideReclaim(failed, now, 'sweeper')).toEqual({
      action: 'backoff',
    });
    expect(decideReclaim(failed, at(1), 'sweeper')).toEqual({
      action: 'reclaim',
      stale: false,
    });
  });

  it('dead-letters a failed event that used up its attempts', () => {
    expect(
      decideReclaim(
        row({ status: 'failed', attempts: GATEWAY_EVENT_MAX_ATTEMPTS }),
        now,
        'redelivery',
      ),
    ).toEqual({ action: 'dead_letter' });
  });

  it('leaves a live processing lease alone', () => {
    expect(
      decideReclaim(row({ nextAttemptAt: at(60_000) }), now, 'redelivery'),
    ).toEqual({ action: 'in_flight' });
    expect(decideReclaim(row({ receivedAt: now }), now, 'sweeper')).toEqual({
      action: 'in_flight',
    });
  });

  it('reclaims a stale processing row (explicit lease or the default lease from receipt)', () => {
    expect(
      decideReclaim(row({ nextAttemptAt: at(-1) }), now, 'redelivery'),
    ).toEqual({ action: 'reclaim', stale: true });
    expect(
      decideReclaim(
        row({ receivedAt: at(-GATEWAY_EVENT_LEASE_MS) }),
        now,
        'sweeper',
      ),
    ).toEqual({ action: 'reclaim', stale: true });
  });

  it('dead-letters a stale processing row on its last attempt', () => {
    expect(
      decideReclaim(
        row({
          nextAttemptAt: at(-1),
          attempts: GATEWAY_EVENT_MAX_ATTEMPTS - 1,
        }),
        now,
        'sweeper',
      ),
    ).toEqual({ action: 'dead_letter' });
  });
});

describe('failureOutcome', () => {
  it('backs off after each failure', () => {
    expect(failureOutcome(1, now)).toEqual({
      status: 'failed',
      nextAttemptAt: at(GATEWAY_EVENT_BACKOFF_MS[0]),
    });
    expect(failureOutcome(4, now).nextAttemptAt).toEqual(
      at(GATEWAY_EVENT_BACKOFF_MS[3]),
    );
  });

  it('dead-letters on the last attempt', () => {
    expect(failureOutcome(GATEWAY_EVENT_MAX_ATTEMPTS, now)).toEqual({
      status: 'dead_letter',
      nextAttemptAt: null,
    });
    expect(failureOutcome(GATEWAY_EVENT_MAX_ATTEMPTS - 1, now).status).toBe(
      'failed',
    );
  });
});
