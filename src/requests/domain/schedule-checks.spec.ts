import {
  assignment,
  check,
  customer,
  failure,
  provider,
  schedule,
  snapshot,
  staff,
} from './guard.testkit';
import { LIFECYCLE_GUARDS } from './lifecycle-guards';
import {
  checkScheduleInterval,
  confirmedJobConflictMessage,
  type ScheduleProviderCalendar,
} from './schedule-checks';
import type { RequestSnapshot } from './snapshot';

describe('checkScheduleInterval (04 §6.13 propose table)', () => {
  const alex: ScheduleProviderCalendar = {
    displayName: 'Alex',
    workingHours: {
      mon: { start: '08:00', end: '17:00' },
      tue: { start: '09:00', end: '12:00' },
      wed: { start: '08:00', end: '17:00' },
    },
    timeOff: [],
  };
  // Monday 26 Oct 2026, 07:00 WAT.
  const now = new Date('2026-10-26T06:00:00.000Z');
  const at = (iso: string) => new Date(iso);
  const check_ = (
    startAt: Date,
    endAt: Date,
    overrides: Partial<Parameters<typeof checkScheduleInterval>[0]> = {},
  ) =>
    checkScheduleInterval({
      startAt,
      endAt,
      now,
      provider: alex,
      overlap: null,
      ...overrides,
    });

  it('accepts an interval inside the provider hours', () => {
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-26T11:00:00.000Z')),
    ).toBeNull();
  });

  it('requires a future start', () => {
    expect(check_(now, at('2026-10-26T07:00:00.000Z'))).toBe(
      'Choose a future date and time.',
    );
  });

  it('requires the end after the start', () => {
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-26T09:00:00.000Z')),
    ).toBe('The end time must be after the start time.');
  });

  it('allows an end exactly 60 days after the start and refuses one millisecond later', () => {
    const start = at('2026-10-26T09:00:00.000Z');
    const sixtyDays = new Date(start.getTime() + 60 * 86_400_000);
    // 24 Dec 2026 is a Thursday, so only the 60-day row is under test here.
    expect(
      check_(start, new Date(sixtyDays.getTime() + 1), {
        provider: { ...alex, workingHours: {} },
      }),
    ).toBe('Choose an end within 60 days of the start.');
    expect(
      check_(start, sixtyDays, { provider: { ...alex, workingHours: {} } }),
    ).not.toBe('Choose an end within 60 days of the start.');
  });

  it('refuses a day the provider does not work', () => {
    expect(
      check_(at('2026-10-29T09:00:00.000Z'), at('2026-10-29T10:00:00.000Z')),
    ).toBe('Alex doesn’t work on Thursdays.');
  });

  it('refuses an interval whose end day is a day off', () => {
    expect(
      check_(at('2026-10-28T09:00:00.000Z'), at('2026-10-29T10:00:00.000Z')),
    ).toBe('Alex doesn’t work on Thursdays.');
  });

  it('refuses time off on any date of the interval', () => {
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-28T10:00:00.000Z'), {
        provider: {
          ...alex,
          timeOff: [{ from: '2026-10-27', to: '2026-10-27' }],
        },
      }),
    ).toBe('Alex is on time off on 2026-10-27.');
  });

  it('refuses a same-day interval outside that day’s hours', () => {
    expect(
      check_(at('2026-10-26T15:00:00.000Z'), at('2026-10-26T17:00:00.000Z')),
    ).toBe('This time is outside Alex’s working hours (Monday 08:00–17:00).');
  });

  it('checks the start against the start day and the end against the end day for multi-day intervals', () => {
    // Monday 10:00 WAT to Tuesday 14:00 WAT: Tuesday ends at 12:00.
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-27T13:00:00.000Z')),
    ).toBe('This time is outside Alex’s working hours (Tuesday 09:00–12:00).');
    // Monday 10:00 WAT to Tuesday 11:00 WAT fits both days.
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-27T10:00:00.000Z')),
    ).toBeNull();
  });

  it('quotes the conflicting appointment, not the proposed interval, as HH:mm WAT', () => {
    expect(
      check_(at('2026-10-26T09:00:00.000Z'), at('2026-10-26T11:00:00.000Z'), {
        overlap: {
          startAt: at('2026-10-26T10:00:00.000Z'),
          endAt: at('2026-10-26T12:30:00.000Z'),
        },
      }),
    ).toBe(
      'This provider already has an appointment between 11:00 and 13:30. Choose another time.',
    );
  });

  it('reports rows in table order when several fail', () => {
    const overlap = {
      startAt: at('2026-10-26T09:00:00.000Z'),
      endAt: at('2026-10-26T11:00:00.000Z'),
    };
    // Past, reversed, off day and overlapping at once: the future row wins.
    expect(
      check_(at('2026-10-22T09:00:00.000Z'), at('2026-10-22T08:00:00.000Z'), {
        overlap,
      }),
    ).toBe('Choose a future date and time.');
    // Off day beats overlap.
    expect(
      check_(at('2026-10-29T09:00:00.000Z'), at('2026-10-29T10:00:00.000Z'), {
        overlap,
      }),
    ).toBe('Alex doesn’t work on Thursdays.');
  });
});

describe('confirmedJobConflictMessage (04 §6.13 provider hours)', () => {
  it('uses the WAT date and the XPR id', () => {
    // 23:30 UTC on the 25th is 00:30 WAT on the 26th.
    expect(
      confirmedJobConflictMessage(new Date('2026-10-25T23:30:00.000Z'), 12),
    ).toBe(
      'You have a confirmed job on 2026-10-26 (XPR-00012). Ask XPro to move it before changing these hours.',
    );
  });
});

describe('schedule.propose guard (04 §6.13 propose table, §5.2 #22 and #25)', () => {
  const run = (snap: RequestSnapshot, actor = staff('schedule.manage')) =>
    check(LIFECYCLE_GUARDS, 'schedule.propose', snap, actor);
  const ready = (overrides: Partial<RequestSnapshot> = {}) =>
    snapshot({
      status: 'ready_to_schedule',
      currentProviderUserId: 'provider-1',
      providerStanding: 'active',
      currentAssignment: assignment('accepted'),
      ...overrides,
    });
  const conflict = (message: string) => failure(409, 'STATE_CONFLICT', message);

  it('needs schedule.manage', () => {
    expect(run(ready(), staff('request.cancel'))).toMatchObject({
      status: 403,
    });
    expect(run(ready(), customer())).toMatchObject({ status: 403 });
  });

  it.each(['ready_to_schedule', 'scheduled'] as const)('accepts %s', (status) =>
    expect(run(ready({ status }))).toEqual({ ok: true }),
  );

  it('accepts a job held before work started (D-06)', () => {
    expect(
      run(
        ready({
          status: 'blocked',
          hold: { kind: 'staff', previousStatus: 'scheduled' },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      'a hold that began during work',
      { kind: 'staff', previousStatus: 'in_progress' },
    ],
    ['a blocker with no hold', null],
  ] as const)(
    'refuses blocked after %s as already in execution',
    (_name, hold) =>
      expect(run(ready({ status: 'blocked', hold: hold as never }))).toEqual(
        conflict('This job has already entered execution.'),
      ),
  );

  it.each(['in_progress', 'completion_pending', 'acknowledged'] as const)(
    'refuses %s as already in execution',
    (status) =>
      expect(run(ready({ status }))).toEqual(
        conflict('This job has already entered execution.'),
      ),
  );

  it('refuses awaiting_payment with the payment message', () => {
    expect(run(ready({ status: 'awaiting_payment' }))).toEqual(
      conflict(
        "The customer hasn't paid yet. Schedule once payment is received.",
      ),
    );
  });

  it.each(['submitted', 'under_review', 'matched', 'quoted'] as const)(
    'refuses %s as an earlier stage',
    (status) =>
      expect(run(ready({ status }))).toEqual(
        conflict(
          'An accepted quote and provider assignment are required for scheduling.',
        ),
      ),
  );

  it('refuses a closed or cancelling request first', () => {
    expect(run(ready({ status: 'cancelling' }))).toEqual(
      conflict('This request is no longer open.'),
    );
  });

  it('checks the payout row before the standing row (D-08)', () => {
    expect(
      run(
        ready({ replacementPayoutPending: true, providerStanding: 'delisted' }),
      ),
    ).toEqual(conflict("Set the new provider's payout before scheduling."));
  });

  it.each(['suspended', 'delisted', 'restricted'] as const)(
    'refuses a %s provider with the standing message',
    (providerStanding) =>
      expect(run(ready({ providerStanding }))).toEqual(
        conflict(
          'This provider is suspended. Replace them or wait for reactivation.',
        ),
      ),
  );
});

describe('schedule.respond guard (04 §6.13 respond table, §5.2 #23)', () => {
  const proposed = (overrides: Partial<RequestSnapshot> = {}) =>
    snapshot({
      status: 'ready_to_schedule',
      currentProviderUserId: 'provider-1',
      providerStanding: 'active',
      currentAssignment: assignment('accepted'),
      currentSchedule: schedule('proposed'),
      ...overrides,
    });
  const run = (snap: RequestSnapshot, input?: unknown, actor = customer()) =>
    check(LIFECYCLE_GUARDS, 'schedule.respond', snap, actor, input);
  const conflict = (message: string) => failure(409, 'STATE_CONFLICT', message);
  const NOT_AWAITING = 'This schedule is no longer awaiting confirmation.';

  it('accepts either party on a proposed schedule', () => {
    expect(run(proposed(), { accept: true })).toEqual({ ok: true });
    expect(run(proposed(), { accept: true }, provider())).toEqual({ ok: true });
  });

  it.each(['confirmed', 'changes_requested', 'cancelled'] as const)(
    'refuses a %s current schedule',
    (status) =>
      expect(
        run(proposed({ currentSchedule: schedule(status) }), { accept: true }),
      ).toEqual(conflict(NOT_AWAITING)),
  );

  it('refuses when there is no current schedule', () => {
    expect(run(proposed({ currentSchedule: null }), { accept: true })).toEqual(
      conflict(NOT_AWAITING),
    );
  });

  it.each(['in_progress', 'completion_pending', 'acknowledged'] as const)(
    'refuses a proposal once the job is %s (D-07)',
    (status) =>
      expect(run(proposed({ status }), { accept: true })).toEqual(
        conflict(NOT_AWAITING),
      ),
  );

  it('refuses a proposal while blocked on work, but not on a pre-start hold', () => {
    expect(
      run(
        proposed({
          status: 'blocked',
          hold: { kind: 'staff', previousStatus: 'in_progress' },
        }),
        { accept: true },
      ),
    ).toEqual(conflict(NOT_AWAITING));
    expect(
      run(
        proposed({
          status: 'blocked',
          hold: { kind: 'staff', previousStatus: 'scheduled' },
        }),
        { accept: true },
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a party that already responded', () => {
    expect(
      run(
        proposed({
          currentSchedule: schedule('proposed', { customer: 'accepted' }),
        }),
        { accept: true },
      ),
    ).toEqual(conflict('Your response has already been recorded.'));
  });

  it('requires a note to decline, after the state and party rows (D-32)', () => {
    expect(run(proposed(), { accept: false, note: '  ' })).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Explain your requested schedule change.',
      ),
    );
    expect(run(proposed(), { accept: false, note: 'Not that day' })).toEqual({
      ok: true,
    });
    expect(run(proposed({ currentSchedule: null }), { accept: false })).toEqual(
      conflict(NOT_AWAITING),
    );
    expect(
      run(
        proposed({
          currentSchedule: schedule('proposed', { customer: 'accepted' }),
        }),
        { accept: false },
      ),
    ).toEqual(conflict('Your response has already been recorded.'));
  });

  it('does not check the decline note without a body (allowed actions)', () => {
    expect(run(proposed())).toEqual({ ok: true });
  });

  it('refuses someone who is not the customer or the current provider', () => {
    expect(
      run(proposed(), { accept: true }, provider('other-provider')),
    ).toMatchObject({ status: 403 });
  });
});
