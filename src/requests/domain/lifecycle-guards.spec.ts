import {
  assertOpen,
  CANCELLABLE_STATUSES,
  LIFECYCLE_GUARDS,
} from './lifecycle-guards';
import {
  assignment,
  check,
  customer,
  failure,
  HOUR,
  NOW,
  provider,
  schedule,
  snapshot,
  staff,
} from './guard.testkit';
import type { ActorView, RequestSnapshot } from './snapshot';
import { REQUEST_STATUSES, type RequestStatus } from './statuses';

const run = (
  key: string,
  snap: RequestSnapshot,
  actor: ActorView,
  input?: unknown,
) => check(LIFECYCLE_GUARDS, key, snap, actor, input);
const NO_LONGER_OPEN = failure(
  409,
  'STATE_CONFLICT',
  'This request is no longer open.',
);

describe('lifecycle allowed-action guards', () => {
  const scheduled = (overrides: Partial<RequestSnapshot> = {}) =>
    snapshot({
      status: 'scheduled',
      currentProviderUserId: 'provider-1',
      providerStanding: 'active',
      currentAssignment: assignment('accepted'),
      ...overrides,
    });

  it('limits schedule responses to the current customer or provider', () => {
    const row = scheduled({
      currentSchedule: schedule('proposed'),
    });
    expect(run('schedule.respond', row, customer())).toEqual({ ok: true });
    expect(run('schedule.respond', row, provider())).toEqual({ ok: true });
    expect(run('schedule.respond', row, provider('other'))).toMatchObject({
      status: 403,
    });
  });

  it('hides schedule.respond from a party that already responded', () => {
    const row = scheduled({
      currentSchedule: schedule('proposed', { customer: 'accepted' }),
    });
    expect(run('schedule.respond', row, customer())).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Your response has already been recorded.',
      ),
    );
    expect(run('schedule.respond', row, provider())).toEqual({ ok: true });
  });

  it('blocks close when issues remain', () => {
    const row = snapshot({
      status: 'acknowledged',
      openIssues: [{ status: 'open' }],
    });
    expect(run('request.close', row, staff('request.close'))).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it('refuses staff without the permission with the staff message', () => {
    const row = scheduled({ currentSchedule: schedule('confirmed') });
    expect(run('noshow.record', row, staff('progress.review'))).toEqual(
      failure(403, 'FORBIDDEN', 'Your staff role does not allow this action.'),
    );
    expect(run('noshow.record', row, staff('dispatch.manage'))).toEqual({
      ok: true,
    });
  });
});

describe('assertOpen (04 §6.18)', () => {
  it.each(['closed', 'cancelled', 'rejected', 'cancelling'] as const)(
    'refuses a %s request',
    (status) => {
      expect(assertOpen(snapshot({ status }))).toEqual(NO_LONGER_OPEN);
    },
  );

  it.each(
    REQUEST_STATUSES.filter(
      (status) =>
        !['closed', 'cancelled', 'rejected', 'cancelling'].includes(status),
    ),
  )('lets a %s request through', (status) => {
    expect(assertOpen(snapshot({ status }))).toEqual({ ok: true });
  });

  const everyone = {
    ops: staff(
      'schedule.manage',
      'progress.review',
      'dispatch.manage',
      'issue.resolve',
      'request.close',
    ),
  };
  const changing: Array<[string, ActorView]> = [
    ['schedule.propose', everyone.ops],
    ['schedule.respond', customer()],
    ['schedule.requestChange', customer()],
    ['progress.add', provider()],
    ['progress.review', everyone.ops],
    ['progress.addOnBehalf', everyone.ops],
    ['request.hold', everyone.ops],
    ['request.releaseHold', everyone.ops],
    ['noshow.record', everyone.ops],
    ['noshow.confirm', everyone.ops],
    ['noshow.dismiss', everyone.ops],
    ['noshow.correct', everyone.ops],
    ['completion.respond', customer()],
    ['completion.confirmOnBehalf', everyone.ops],
    ['issue.raise', customer()],
    ['issue.accept', everyone.ops],
    ['issue.resolve', everyone.ops],
    ['issue.escalate', everyone.ops],
    ['request.close', everyone.ops],
  ];

  it.each(changing)('is the first check of %s', (key, actor) => {
    for (const status of [
      'closed',
      'cancelled',
      'rejected',
      'cancelling',
    ] as const) {
      const result = run(
        key,
        snapshot({
          status,
          currentProviderUserId: 'provider-1',
          currentSchedule: schedule('confirmed'),
          pendingUpdates: [{ kind: 'progress', state: 'pending' }],
          openIssues: [{ status: 'open' }],
          latestNoShow: { status: 'open' },
          hold: { kind: 'staff' },
        }),
        actor,
      );
      expect(result).toEqual(NO_LONGER_OPEN);
    }
  });
});

describe('request.hold and request.releaseHold (04 §6.15)', () => {
  const held = () => snapshot({ status: 'blocked', hold: { kind: 'staff' } });

  it.each(['progress.review', 'dispatch.manage'])(
    'accept %s for both commands',
    (permission) => {
      expect(
        run(
          'request.hold',
          snapshot({ status: 'in_progress' }),
          staff(permission),
        ),
      ).toEqual({ ok: true });
      expect(run('request.releaseHold', held(), staff(permission))).toEqual({
        ok: true,
      });
    },
  );

  it('refuses staff with neither permission', () => {
    const denied = failure(
      403,
      'FORBIDDEN',
      'Your staff role does not allow this action.',
    );
    expect(
      run(
        'request.hold',
        snapshot({ status: 'in_progress' }),
        staff('schedule.manage'),
      ),
    ).toEqual(denied);
    expect(
      run('request.releaseHold', held(), staff('schedule.manage')),
    ).toEqual(denied);
  });

  it('row 1: only a scheduled job or work in progress can be held', () => {
    for (const status of ['scheduled', 'in_progress'] as const)
      expect(
        run('request.hold', snapshot({ status }), staff('dispatch.manage')),
      ).toEqual({ ok: true });
    expect(
      run(
        'request.hold',
        snapshot({ status: 'matched' }),
        staff('dispatch.manage'),
      ),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Only a scheduled job or work in progress can be put on hold.',
      ),
    );
  });

  it('row 2: a reason of 5 to 500 characters when the body is given', () => {
    const expected = failure(
      422,
      'VALIDATION_ERROR',
      'Add a reason for pausing this job.',
    );
    const snap = snapshot({ status: 'in_progress' });
    const ops = staff('dispatch.manage');
    expect(run('request.hold', snap, ops, { reason: 'abc' })).toEqual(expected);
    expect(run('request.hold', snap, ops, { reason: 'x'.repeat(501) })).toEqual(
      expected,
    );
    expect(
      run('request.hold', snap, ops, { reason: 'Site is flooded.' }),
    ).toEqual({ ok: true });
  });

  it('releaseHold: a hold must exist', () => {
    expect(
      run(
        'request.releaseHold',
        snapshot({ status: 'blocked' }),
        staff('dispatch.manage'),
      ),
    ).toEqual(failure(409, 'STATE_CONFLICT', "This job isn't on hold."));
  });

  it('releaseHold: the provider must not be suspended', () => {
    expect(
      run(
        'request.releaseHold',
        { ...held(), providerStanding: 'suspended' },
        staff('dispatch.manage'),
      ),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'This provider is suspended. Replace them or wait for reactivation.',
      ),
    );
  });
});

describe('cancellation guards (04 §5.2 #12, #24)', () => {
  const pending = (
    overrides: Partial<
      RequestSnapshot['pendingCancellationInfo'] & object
    > = {},
  ) => ({
    pendingCancellation: true,
    pendingCancellationInfo: {
      id: 'c-1',
      status: 'pending' as const,
      requestedBy: 'customer' as const,
      paid: false,
      workStarted: false,
      ...overrides,
    },
  });
  const canceller = staff('request.cancel');
  const cancellable: RequestStatus[] = [
    ...CANCELLABLE_STATUSES,
  ] as RequestStatus[];

  it('limits both commands to the statuses of transitions #12 and #24', () => {
    expect([...CANCELLABLE_STATUSES].sort()).toEqual(
      [
        'under_review',
        'matched',
        'quoted',
        'awaiting_payment',
        'ready_to_schedule',
        'scheduled',
        'in_progress',
        'blocked',
        'completion_pending',
      ].sort(),
    );
  });

  it.each(cancellable)('allows request and decide in %s', (status) => {
    expect(
      run('cancellation.request', snapshot({ status }), customer()),
    ).toEqual({ ok: true });
    expect(
      run('cancellation.decide', snapshot({ status, ...pending() }), canceller),
    ).toEqual({ ok: true });
  });

  it.each([
    'submitted',
    'acknowledged',
    'cancelling',
    'closed',
    'cancelled',
    'rejected',
  ] as const)('refuses request and decide in %s', (status) => {
    const expected = failure(
      409,
      'STATE_CONFLICT',
      'This request can no longer be cancelled.',
    );
    expect(
      run('cancellation.request', snapshot({ status }), customer()),
    ).toEqual(expected);
    expect(
      run('cancellation.decide', snapshot({ status, ...pending() }), canceller),
    ).toEqual(expected);
  });

  it('request: one pending request at a time', () => {
    expect(
      run(
        'cancellation.request',
        snapshot({ status: 'matched', ...pending() }),
        customer(),
      ),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Your cancellation request is already awaiting XPro.',
      ),
    );
  });

  it('request and withdraw are only for the owner', () => {
    expect(
      run(
        'cancellation.request',
        snapshot({ status: 'matched' }),
        customer('other'),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      run(
        'cancellation.withdraw',
        snapshot({ status: 'matched', ...pending() }),
        customer(),
      ),
    ).toEqual({ ok: true });
    expect(
      run('cancellation.withdraw', snapshot({ status: 'matched' }), customer()),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'This cancellation request is no longer awaiting a decision.',
      ),
    );
    expect(
      run(
        'cancellation.withdraw',
        snapshot({ status: 'matched', ...pending({ requestedBy: 'staff' }) }),
        customer(),
      ),
    ).toMatchObject({ status: 409 });
  });

  it('decide: something must be pending', () => {
    expect(
      run('cancellation.decide', snapshot({ status: 'matched' }), canceller),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'This cancellation request is no longer awaiting a decision.',
      ),
    );
  });

  it('decide: a paid or started job also needs request.cancel.active', () => {
    const denied = failure(
      403,
      'FORBIDDEN',
      'Your staff role does not allow this action.',
    );
    expect(
      run(
        'cancellation.decide',
        snapshot({ status: 'scheduled', ...pending({ paid: true }) }),
        canceller,
      ),
    ).toEqual(denied);
    expect(
      run(
        'cancellation.decide',
        snapshot({ status: 'in_progress', ...pending({ workStarted: true }) }),
        canceller,
      ),
    ).toEqual(denied);
    expect(
      run(
        'cancellation.decide',
        snapshot({ status: 'scheduled', ...pending({ paid: true }) }),
        staff('request.cancel', 'request.cancel.active'),
      ),
    ).toEqual({ ok: true });
  });

  it('decide: rejecting needs a reason', () => {
    const snap = snapshot({ status: 'matched', ...pending() });
    expect(
      run('cancellation.decide', snap, canceller, { approve: false }),
    ).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Add a reason for rejecting this cancellation request.',
      ),
    );
    expect(
      run('cancellation.decide', snap, canceller, {
        approve: false,
        note: 'Work is under way.',
      }),
    ).toEqual({ ok: true });
  });

  it('decide: a payment younger than 30 minutes blocks an approval', () => {
    const recent = {
      paid: false,
      pendingPaymentAt: new Date(NOW.getTime() - 5 * 60_000),
      offlineRecorded: false,
    };
    const snap = snapshot({
      status: 'awaiting_payment',
      payment: recent,
      ...pending(),
    });
    expect(
      run('cancellation.decide', snap, canceller, { approve: true }),
    ).toEqual(
      failure(
        409,
        'PAYMENT_IN_PROGRESS',
        'A payment is still processing. Try again shortly.',
      ),
    );
    expect(
      run('cancellation.decide', snap, canceller, {
        approve: false,
        note: 'Payment is still coming in.',
      }),
    ).toEqual({ ok: true });
    expect(
      run(
        'cancellation.decide',
        {
          ...snap,
          payment: {
            paid: false,
            pendingPaymentAt: new Date(NOW.getTime() - HOUR),
            offlineRecorded: false,
          },
        },
        canceller,
        { approve: true },
      ),
    ).toEqual({ ok: true });
  });
});

describe('request.close (04 §5.2 #36)', () => {
  const closer = staff('request.close');
  const ready = (overrides: Partial<RequestSnapshot> = {}) =>
    snapshot({
      status: 'acknowledged',
      defectsWindowEndsAt: new Date(NOW.getTime() - HOUR),
      ...overrides,
    });

  it('passes for an acknowledged request with no issue or cancellation', () => {
    expect(run('request.close', ready(), closer)).toEqual({ ok: true });
  });

  it('refuses while a cancellation is pending', () => {
    expect(
      run('request.close', ready({ pendingCancellation: true }), closer),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'A cancellation request is waiting. Decide it before closing.',
      ),
    );
  });

  it('needs a note to close early when the body is given', () => {
    const early = ready({
      defectsWindowEndsAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(run('request.close', early, closer)).toEqual({ ok: true });
    expect(run('request.close', early, closer, { note: '' })).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Add a reason to close this request before the defects window ends.',
      ),
    );
    expect(
      run('request.close', early, closer, { note: 'Customer asked to close.' }),
    ).toEqual({ ok: true });
  });
});

describe('execution and completion guards keep their service messages', () => {
  it('progress.add refuses a held job with the paused message', () => {
    expect(
      run(
        'progress.add',
        snapshot({
          status: 'blocked',
          currentProviderUserId: 'provider-1',
          hold: { kind: 'staff' },
        }),
        provider(),
      ),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'XPro has paused this job. Message XPro Dispatch before continuing.',
      ),
    );
  });

  it('schedule.propose reports the stage the job is in', () => {
    const ops = staff('schedule.manage');
    expect(
      run('schedule.propose', snapshot({ status: 'awaiting_payment' }), ops),
    ).toMatchObject({
      message:
        "The customer hasn't paid yet. Schedule once payment is received.",
    });
    expect(
      run('schedule.propose', snapshot({ status: 'in_progress' }), ops),
    ).toMatchObject({ message: 'This job has already entered execution.' });
    expect(
      run('schedule.propose', snapshot({ status: 'matched' }), ops),
    ).toMatchObject({
      message:
        'An accepted quote and provider assignment are required for scheduling.',
    });
    expect(
      run(
        'schedule.propose',
        snapshot({
          status: 'ready_to_schedule',
          replacementPayoutPending: true,
        }),
        ops,
      ),
    ).toMatchObject({
      message: "Set the new provider's payout before scheduling.",
    });
  });
});
