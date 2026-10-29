import { ESCALATION_GUARDS } from './escalation-guards';
import type { RequestSnapshot } from './snapshot';
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

describe('request.escalate body rules (02 §6.10)', () => {
  const escalate = (
    input: unknown,
    openEscalations: RequestSnapshot['openEscalations'] = [],
    status: RequestStatus = 'in_progress',
  ) =>
    check(
      ESCALATION_GUARDS,
      'request.escalate',
      snapshot({ status, openEscalations }),
      staff('request.escalate'),
      input,
    );

  it('needs a note of 5 or more characters first', () => {
    expect(escalate({ to: 'operations', note: ' abc ' })).toEqual(
      failure(422, 'VALIDATION_ERROR', 'Add a note explaining the escalation.'),
    );
    expect(
      escalate({ to: 'operations', note: 'abc' }, [], 'closed'),
    ).toMatchObject({ status: 422 });
    expect(escalate({ to: 'operations', note: 'Check the access.' })).toEqual({
      ok: true,
    });
  });

  it('refuses a second open escalation to the same target', () => {
    const open = [{ id: 'e1', to: 'operations' as const, raisedBy: 'x' }];
    expect(
      escalate({ to: 'operations', note: 'Check it again.' }, open),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'This request already has an open escalation to operations.',
      ),
    );
  });

  it('allows one open escalation per target', () => {
    const open = [{ id: 'e1', to: 'operations' as const, raisedBy: 'x' }];
    expect(
      escalate({ to: 'super_admin', note: 'Needs a super admin.' }, open),
    ).toEqual({ ok: true });
  });
});

describe('request.escalation.resolve row rules (02 §6.10, §6.14 rule 10)', () => {
  const open = (to: 'operations' | 'super_admin', raisedBy: string | null) =>
    snapshot({ openEscalations: [{ id: 'e1', to, raisedBy }] });
  const resolve = (
    snap: ReturnType<typeof snapshot>,
    actor: ReturnType<typeof staff>,
    input: unknown = { escalationId: 'e1', note: 'Sorted it out.' },
  ) =>
    check(ESCALATION_GUARDS, 'request.escalation.resolve', snap, actor, input);
  const resolver = () => staff('request.escalation.resolve');
  const superAdmin = () => ({ ...resolver(), isSuperAdmin: true });

  it('resolves an escalation someone else raised', () => {
    expect(resolve(open('operations', 'staff-9'), resolver())).toEqual({
      ok: true,
    });
    expect(resolve(open('operations', null), resolver())).toEqual({ ok: true });
  });

  it('is a 409 when the escalation is not open', () => {
    expect(
      resolve(open('operations', 'staff-9'), resolver(), {
        escalationId: 'zz',
        note: 'Sorted it out.',
      }),
    ).toEqual(
      failure(409, 'STATE_CONFLICT', 'This escalation is no longer open.'),
    );
    expect(resolve(snapshot(), resolver())).toMatchObject({ status: 409 });
  });

  it('is a 403 for the raiser unless they are a super admin', () => {
    expect(resolve(open('operations', 'staff-1'), resolver())).toEqual(
      failure(
        403,
        'FORBIDDEN',
        'Someone else must resolve an escalation you raised.',
      ),
    );
    expect(resolve(open('operations', 'staff-1'), superAdmin())).toEqual({
      ok: true,
    });
  });

  it('is a 403 for anyone but a super admin on a super_admin escalation', () => {
    expect(resolve(open('super_admin', 'staff-9'), resolver())).toEqual(
      failure(
        403,
        'FORBIDDEN',
        'Only a super admin can resolve this escalation.',
      ),
    );
    expect(resolve(open('super_admin', 'staff-9'), superAdmin())).toEqual({
      ok: true,
    });
  });

  it('checks the raiser rule before the super-admin rule, then the note', () => {
    expect(resolve(open('super_admin', 'staff-1'), resolver())).toMatchObject({
      message: 'Someone else must resolve an escalation you raised.',
    });
    expect(
      resolve(open('operations', 'staff-9'), resolver(), {
        escalationId: 'e1',
        note: 'ok',
      }),
    ).toEqual(failure(422, 'VALIDATION_ERROR', 'Add a resolution note.'));
  });
});
