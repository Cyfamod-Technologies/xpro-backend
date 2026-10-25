import { ESCALATION_GUARDS } from './escalation-guards';
import type { RequestStatus } from './statuses';
import { check, customer, failure, snapshot, staff } from './guard.testkit';

describe('request.escalate', () => {
  const escalate = (
    status: RequestStatus = 'in_progress',
    actor = staff('request.escalate'),
  ) =>
    check(ESCALATION_GUARDS, 'request.escalate', snapshot({ status }), actor);

  it('passes for staff with request.escalate on an open request', () => {
    expect(escalate()).toEqual({ ok: true });
    expect(escalate('cancelling')).toEqual({ ok: true });
  });

  it('needs request.escalate', () => {
    expect(escalate('in_progress', staff('request.close'))).toEqual(
      failure(403, 'FORBIDDEN', 'Your staff role does not allow this action.'),
    );
    expect(escalate('in_progress', customer() as never)).toMatchObject({
      status: 403,
    });
  });

  it.each(['closed', 'cancelled', 'rejected'] as const)(
    'refuses a %s request',
    (status) => {
      expect(escalate(status)).toEqual(
        failure(409, 'STATE_CONFLICT', 'This request is no longer open.'),
      );
    },
  );
});

describe('request.escalation.resolve', () => {
  it('needs request.escalation.resolve and checks no request state', () => {
    for (const status of ['in_progress', 'closed'] as const)
      expect(
        check(
          ESCALATION_GUARDS,
          'request.escalation.resolve',
          snapshot({ status }),
          staff('request.escalation.resolve'),
        ),
      ).toEqual({ ok: true });
    expect(
      check(
        ESCALATION_GUARDS,
        'request.escalation.resolve',
        snapshot(),
        staff('request.escalate'),
      ),
    ).toEqual(
      failure(403, 'FORBIDDEN', 'Your staff role does not allow this action.'),
    );
  });
});
