import { DISPATCH_GUARDS } from './dispatch-guards';
import type { RequestStatus } from './statuses';
import {
  assignment,
  check,
  customer,
  failure,
  HOUR,
  NOW,
  provider,
  quote,
  schedule,
  snapshot,
  staff,
  system,
} from './guard.testkit';

const dispatcher = staff('dispatch.manage');
const dispatching = () =>
  snapshot({ status: 'under_review', intake: { state: 'approved' } });
const run = (
  key: string,
  snap = dispatching(),
  actor = dispatcher,
  input?: unknown,
  settings: Record<string, unknown> = {},
) => check(DISPATCH_GUARDS, key, snap, actor, input, settings);

describe('dispatch guards (04 §6.6 table)', () => {
  describe.each(['assignment.auto', 'assignment.offer'])('%s', (key) => {
    it('passes for dispatch staff on an approved request with nobody assigned', () => {
      expect(run(key)).toEqual({ ok: true });
    });

    it('refuses other actors and staff without dispatch.manage', () => {
      expect(run(key, dispatching(), staff('request.review'))).toMatchObject({
        status: 403,
        message: 'Your staff role does not allow this action.',
      });
      expect(run(key, dispatching(), customer() as never)).toMatchObject({
        status: 403,
      });
    });

    it('row 1: intake approved and under_review', () => {
      const expected = failure(
        409,
        'STATE_CONFLICT',
        'Approve the intake before assigning a provider.',
      );
      expect(
        run(
          key,
          snapshot({ status: 'under_review', intake: { state: 'pending' } }),
        ),
      ).toEqual(expected);
      expect(
        run(
          key,
          snapshot({ status: 'matched', intake: { state: 'approved' } }),
        ),
      ).toEqual(expected);
    });

    it('row 2: no current assignment', () => {
      for (const status of ['offered', 'pending_approval', 'accepted'] as const)
        expect(
          run(key, { ...dispatching(), currentAssignment: assignment(status) }),
        ).toEqual(
          failure(
            409,
            'STATE_CONFLICT',
            'Withdraw the current offer or assignment before reassigning.',
          ),
        );
    });

    it('row 3: no pending cancellation', () => {
      expect(run(key, { ...dispatching(), pendingCancellation: true })).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'A cancellation request is waiting. Decide it before assigning a provider.',
        ),
      );
    });

    it('row 4: customer not suspended', () => {
      expect(
        run(key, { ...dispatching(), customerStanding: 'suspended' }),
      ).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'This customer is suspended. Resolve the suspension before assigning a provider.',
        ),
      );
    });

    it('reports the first failing row when several fail', () => {
      expect(
        run(
          key,
          snapshot({
            status: 'under_review',
            intake: { state: 'pending' },
            currentAssignment: assignment('offered'),
            pendingCancellation: true,
          }),
        ),
      ).toMatchObject({
        message: 'Approve the intake before assigning a provider.',
      });
    });

    it('refuses a request that is no longer open before anything else', () => {
      expect(run(key, snapshot({ status: 'cancelling' }))).toMatchObject({
        message: 'This request is no longer open.',
      });
    });
  });

  describe('assignment.auto limit and reset note', () => {
    const atLimit = () => ({ ...dispatching(), autoAttempts: 3 });

    it('refuses a run at the limit without resetAttempts', () => {
      expect(run('assignment.auto', atLimit(), dispatcher, {})).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'Automatic assignment has used its 3 offers. Reset the count with a note, or choose a provider.',
        ),
      );
    });

    it('uses the configured limit', () => {
      expect(
        run(
          'assignment.auto',
          { ...dispatching(), autoAttempts: 2 },
          dispatcher,
          {},
          { 'assignment.maxAutoAttempts': 2 },
        ),
      ).toMatchObject({
        message:
          'Automatic assignment has used its 2 offers. Reset the count with a note, or choose a provider.',
      });
    });

    it('allows a reset with a note and refuses a reset without one', () => {
      expect(
        run('assignment.auto', atLimit(), dispatcher, {
          resetAttempts: true,
          note: 'Customer changed the brief.',
        }),
      ).toEqual({ ok: true });
      expect(
        run('assignment.auto', atLimit(), dispatcher, {
          resetAttempts: true,
          note: '  ',
        }),
      ).toEqual(
        failure(
          422,
          'VALIDATION_ERROR',
          'Add a note explaining why you are resetting automatic assignment.',
        ),
      );
    });

    it('skips the body checks when no input is given', () => {
      expect(run('assignment.auto', atLimit())).toEqual({ ok: true });
    });

    it('also lets the system run it', () => {
      expect(run('assignment.auto', dispatching(), system as never)).toEqual({
        ok: true,
      });
    });
  });

  describe('dispatch.cascade', () => {
    it('is for the system only and applies the same four rows', () => {
      expect(run('dispatch.cascade', dispatching(), system as never)).toEqual({
        ok: true,
      });
      expect(run('dispatch.cascade')).toMatchObject({ status: 403 });
      expect(
        run(
          'dispatch.cascade',
          { ...dispatching(), customerStanding: 'suspended' },
          system as never,
        ),
      ).toMatchObject({ status: 409 });
    });
  });

  describe('dispatch.runs', () => {
    it('needs dispatch.manage and an approved request in review', () => {
      expect(run('dispatch.runs')).toEqual({ ok: true });
      expect(run('dispatch.runs', dispatching(), staff())).toMatchObject({
        status: 403,
      });
      expect(
        run('dispatch.runs', snapshot({ status: 'submitted' })),
      ).toMatchObject({
        message: 'Approve the intake before assigning a provider.',
      });
    });
  });

  describe('assignment.respond (04 §6.8)', () => {
    const offered = (expiresInHours = 4) =>
      snapshot({
        status: 'under_review',
        intake: { state: 'approved' },
        currentProviderUserId: 'provider-1',
        providerStanding: 'active',
        currentAssignment: assignment('offered', {
          expiresAt: new Date(NOW.getTime() + expiresInHours * HOUR),
        }),
      });
    const respond = (snap = offered(), actor = provider(), input?: unknown) =>
      check(DISPATCH_GUARDS, 'assignment.respond', snap, actor, input);

    it('passes for the offered provider before expiry', () => {
      expect(respond()).toEqual({ ok: true });
      expect(respond(offered(), provider(), { accept: true })).toEqual({
        ok: true,
      });
    });

    it('row 1: current assignment, held by the actor, offered', () => {
      const expected = failure(
        409,
        'STATE_CONFLICT',
        'This offer is no longer awaiting your response.',
      );
      expect(respond(offered(), provider('provider-2'))).toEqual(expected);
      expect(
        respond({
          ...offered(),
          currentAssignment: assignment('pending_approval'),
        }),
      ).toEqual(expected);
      expect(respond({ ...offered(), currentAssignment: null })).toEqual(
        expected,
      );
    });

    it('row 2: now < expiresAt even when the expiry job has not run', () => {
      expect(respond(offered(0))).toEqual(
        failure(409, 'STATE_CONFLICT', 'This offer has expired.'),
      );
      expect(respond(offered(-1))).toMatchObject({
        message: 'This offer has expired.',
      });
    });

    it('row 3: accepting needs an active provider', () => {
      expect(
        respond({ ...offered(), providerStanding: 'suspended' }, provider(), {
          accept: true,
        }),
      ).toEqual(
        failure(
          422,
          'VALIDATION_ERROR',
          'Your profile must be approved and available to accept work.',
        ),
      );
      expect(
        respond({ ...offered(), providerStanding: 'suspended' }, provider(), {
          accept: false,
          note: 'Fully booked this week.',
        }),
      ).toEqual({ ok: true });
    });

    it('row 5: a decline needs a 3 to 500 character reason', () => {
      const expected = failure(
        422,
        'VALIDATION_ERROR',
        'Add a reason for declining.',
      );
      expect(respond(offered(), provider(), { accept: false })).toEqual(
        expected,
      );
      expect(
        respond(offered(), provider(), { accept: false, note: 'no' }),
      ).toEqual(expected);
      expect(
        respond(offered(), provider(), {
          accept: false,
          note: 'x'.repeat(501),
        }),
      ).toEqual(expected);
      expect(
        respond(offered(), provider(), { accept: false, note: 'Too far away' }),
      ).toEqual({ ok: true });
    });

    it('is not available to customers or staff', () => {
      expect(respond(offered(), customer() as never)).toMatchObject({
        status: 403,
        message: 'This action is not available for your account type.',
      });
      expect(respond(offered(), dispatcher)).toMatchObject({ status: 403 });
    });
  });

  describe('assignment.review (04 §6.9)', () => {
    const pending = () =>
      snapshot({
        status: 'under_review',
        intake: { state: 'approved' },
        currentAssignment: assignment('pending_approval'),
      });

    it('passes for dispatch staff on a pending acceptance', () => {
      expect(run('assignment.review', pending())).toEqual({ ok: true });
    });

    it('row 1: the assignment is current and pending_approval', () => {
      const expected = failure(
        409,
        'STATE_CONFLICT',
        'This assignment is no longer awaiting approval.',
      );
      expect(
        run('assignment.review', {
          ...pending(),
          currentAssignment: assignment('offered'),
        }),
      ).toEqual(expected);
      expect(
        run('assignment.review', { ...pending(), currentAssignment: null }),
      ).toEqual(expected);
    });

    it('row 2: a rejection needs a note', () => {
      expect(
        run('assignment.review', pending(), dispatcher, { approve: false }),
      ).toEqual(
        failure(
          422,
          'VALIDATION_ERROR',
          'Explain why the assignment is not confirmed.',
        ),
      );
      expect(
        run('assignment.review', pending(), dispatcher, {
          approve: false,
          note: 'Not a fit.',
        }),
      ).toEqual({ ok: true });
      expect(
        run('assignment.review', pending(), dispatcher, { approve: true }),
      ).toEqual({ ok: true });
    });

    it('needs dispatch.manage', () => {
      expect(
        run('assignment.review', pending(), staff('progress.review')),
      ).toMatchObject({ status: 403 });
    });
  });

  describe('assignment.withdraw (04 §5.2 #14)', () => {
    const offerOut = () =>
      snapshot({
        status: 'under_review',
        intake: { state: 'approved' },
        currentAssignment: assignment('offered'),
      });

    it.each([
      ['an offered provider in under_review', offerOut()],
      [
        'a pending acceptance in under_review',
        { ...offerOut(), currentAssignment: assignment('pending_approval') },
      ],
      [
        'an accepted provider in matched with no accepted quote',
        snapshot({
          status: 'matched',
          currentAssignment: assignment('accepted'),
          quotes: [quote('draft')],
        }),
      ],
      [
        'an accepted provider in quoted with a sent quote',
        snapshot({
          status: 'quoted',
          currentAssignment: assignment('accepted'),
          quotes: [quote('sent')],
        }),
      ],
    ])('passes for %s', (_name, snap) => {
      expect(run('assignment.withdraw', snap)).toEqual({ ok: true });
    });

    it('refuses when there is no current assignment to withdraw', () => {
      const expected = failure(
        409,
        'STATE_CONFLICT',
        'This offer is no longer current.',
      );
      expect(run('assignment.withdraw', dispatching())).toEqual(expected);
      expect(
        run('assignment.withdraw', {
          ...offerOut(),
          currentAssignment: assignment('completed'),
        }),
      ).toEqual(expected);
    });

    it('refuses once a quote is accepted and points at replace', () => {
      const expected = failure(
        409,
        'STATE_CONFLICT',
        'This provider has an accepted quote. Replace the provider instead.',
      );
      expect(
        run(
          'assignment.withdraw',
          snapshot({
            status: 'awaiting_payment',
            currentAssignment: assignment('accepted'),
            quotes: [quote('accepted')],
          }),
        ),
      ).toEqual(expected);
      expect(
        run('assignment.withdraw', {
          ...offerOut(),
          quotes: [quote('accepted')],
        }),
      ).toEqual(expected);
    });

    it('needs a note when the body is given', () => {
      expect(
        run('assignment.withdraw', offerOut(), dispatcher, { note: ' ' }),
      ).toEqual(
        failure(
          422,
          'VALIDATION_ERROR',
          'Add a note for withdrawing this offer.',
        ),
      );
      expect(
        run('assignment.withdraw', offerOut(), dispatcher, {
          note: 'Provider is unreachable.',
        }),
      ).toEqual({ ok: true });
    });

    it('needs dispatch.manage', () => {
      expect(run('assignment.withdraw', offerOut(), staff())).toMatchObject({
        status: 403,
      });
    });
  });

  describe('assignment.replace (04 §5.2 #21, §6.19)', () => {
    const replaceable = (status: RequestStatus = 'scheduled') =>
      snapshot({
        status,
        currentAssignment: assignment('accepted'),
        quotes: [quote('accepted')],
      });

    it.each(['awaiting_payment', 'ready_to_schedule', 'scheduled'] as const)(
      'passes from %s',
      (status) => {
        expect(run('assignment.replace', replaceable(status))).toEqual({
          ok: true,
        });
      },
    );

    it('requires an accepted assignment, then an accepted quote', () => {
      expect(
        run('assignment.replace', {
          ...replaceable(),
          currentAssignment: assignment('offered'),
        }),
      ).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'This provider is no longer assigned to the request.',
        ),
      );
      expect(
        run('assignment.replace', {
          ...replaceable(),
          quotes: [quote('sent')],
        }),
      ).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'Create or accept a quote before replacing this provider.',
        ),
      );
    });

    it.each([
      'matched',
      'quoted',
      'in_progress',
      'completion_pending',
    ] as const)('refuses from %s', (status) => {
      expect(run('assignment.replace', replaceable(status))).toMatchObject({
        status: 409,
        message: "This provider can't be replaced at this stage of the job.",
      });
    });

    describe('from blocked', () => {
      const blocked = (overrides = {}) => ({
        ...replaceable('blocked'),
        ...overrides,
      });

      it('is allowed for a staff hold', () => {
        expect(
          run('assignment.replace', blocked({ hold: { kind: 'staff' } })),
        ).toEqual({ ok: true });
      });

      it('is allowed for a provider blocker', () => {
        expect(run('assignment.replace', blocked())).toEqual({ ok: true });
      });

      it('is allowed with an open issue', () => {
        expect(
          run(
            'assignment.replace',
            blocked({ openIssues: [{ status: 'open' }] }),
          ),
        ).toEqual({ ok: true });
      });
    });

    it('needs a note when the body is given', () => {
      expect(
        run('assignment.replace', replaceable(), dispatcher, { note: '' }),
      ).toEqual(
        failure(
          422,
          'VALIDATION_ERROR',
          'Add a note explaining why this provider is being replaced.',
        ),
      );
    });

    it('is refused on a cancelling request', () => {
      expect(
        run('assignment.replace', { ...replaceable(), status: 'cancelling' }),
      ).toMatchObject({ message: 'This request is no longer open.' });
    });
  });

  describe('request.shareDetails (04 §6.9)', () => {
    const accepted = () =>
      snapshot({
        status: 'matched',
        currentAssignment: assignment('accepted'),
      });

    it('passes for dispatch staff once a provider is confirmed', () => {
      expect(run('request.shareDetails', accepted())).toEqual({ ok: true });
    });

    it('refuses without a confirmed provider', () => {
      expect(
        run('request.shareDetails', {
          ...accepted(),
          currentAssignment: assignment('offered'),
        }),
      ).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          'Confirm a provider assignment before sharing job details.',
        ),
      );
    });

    it('needs a note to share the address or access before the date is locked', () => {
      const expected = failure(
        422,
        'VALIDATION_ERROR',
        'Add a note explaining why the provider needs the site details before the date is confirmed.',
      );
      expect(
        run('request.shareDetails', accepted(), dispatcher, {
          fields: ['address'],
        }),
      ).toEqual(expected);
      expect(
        run('request.shareDetails', accepted(), dispatcher, {
          fields: ['access', 'description'],
          note: '',
        }),
      ).toEqual(expected);
      expect(
        run('request.shareDetails', accepted(), dispatcher, {
          fields: ['description'],
        }),
      ).toEqual({ ok: true });
      expect(
        run('request.shareDetails', accepted(), dispatcher, {
          fields: ['address'],
          note: 'Provider needs to price the access route.',
        }),
      ).toEqual({ ok: true });
      expect(
        run(
          'request.shareDetails',
          { ...accepted(), currentSchedule: schedule('confirmed') },
          dispatcher,
          { fields: ['address'] },
        ),
      ).toEqual({ ok: true });
    });
  });

  describe('dispatch.setMode (04 §6.6)', () => {
    it('passes for dispatch staff on an open request', () => {
      expect(run('dispatch.setMode', snapshot())).toEqual({ ok: true });
      expect(run('dispatch.setMode', dispatching(), staff())).toMatchObject({
        status: 403,
      });
    });

    it('needs a note when the body is given', () => {
      expect(
        run('dispatch.setMode', dispatching(), dispatcher, {
          mode: 'manual',
          note: 'ok',
        }),
      ).toEqual(
        failure(422, 'VALIDATION_ERROR', 'Add a note explaining the change.'),
      );
      expect(
        run('dispatch.setMode', dispatching(), dispatcher, {
          mode: 'manual',
          note: 'Customer wants a named provider.',
        }),
      ).toEqual({ ok: true });
    });

    it('is refused on a closed request', () => {
      expect(
        run('dispatch.setMode', snapshot({ status: 'closed' })),
      ).toMatchObject({ message: 'This request is no longer open.' });
    });
  });

  it('no longer carries the bogus dispatch.manage action key', () => {
    expect(Object.keys(DISPATCH_GUARDS)).not.toContain('dispatch.manage');
  });
});
