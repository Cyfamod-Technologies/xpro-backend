import { allowedActions } from './allowed-actions';
import { OWNERSHIP_GUARDS } from './ownership-guards';
import { REQUEST_GUARDS } from './request-guard-registry';
import type { ActorView, RequestSnapshot } from './snapshot';

const request = (overrides: Partial<RequestSnapshot> = {}) =>
  ({
    id: 'request-1',
    number: 'XPR-00001',
    ownerId: 'customer-1',
    staffOwnerId: null,
    status: 'submitted',
    intake: { state: 'pending' },
    assignments: [],
    quotes: [],
    ...overrides,
  }) as RequestSnapshot;
const now = new Date('2026-10-23T10:00:00.000Z');
const check = (
  name: keyof typeof OWNERSHIP_GUARDS,
  snap: RequestSnapshot,
  actor: ActorView,
  input?: unknown,
) => OWNERSHIP_GUARDS[name](snap, actor, input, now, {});

describe('request ownership guards', () => {
  it('allows a can-own staff member to claim only an unowned open request', () => {
    const ownerCapable: ActorView = {
      kind: 'staff',
      userId: 'staff-1',
      canOwn: true,
      permissions: new Set(['request.claim']),
    };
    expect(check('request.claim', request(), ownerCapable)).toEqual({
      ok: true,
    });
    expect(
      check(
        'request.claim',
        request({ staffOwnerId: 'staff-2' }),
        ownerCapable,
      ),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: 'This request already has an owner.',
    });
    expect(
      check('request.claim', request({ status: 'closed' }), ownerCapable),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check('request.claim', request(), { ...ownerCapable, canOwn: false }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      check('request.claim', request(), {
        ...ownerCapable,
        permissions: new Set(),
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('allows release for the owner or request.reassign and checks a supplied owner revision and note', () => {
    const owned = request({ staffOwnerId: 'staff-1' });
    const owner: ActorView = { kind: 'staff', userId: 'staff-1' };
    expect(check('request.release', owned, owner)).toEqual({ ok: true });
    expect(
      check('request.release', owned, {
        kind: 'staff',
        permissions: new Set(['request.reassign']),
      }),
    ).toEqual({ ok: true });
    expect(check('request.release', owned, { kind: 'staff' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      check('request.release', owned, owner, {
        expectedOwnerId: 'staff-2',
        note: 'Queue it now',
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: "This request's owner has changed. Refresh and retry.",
    });
    expect(
      check('request.release', owned, owner, {
        expectedOwnerId: 'staff-1',
        note: 'no',
      }),
    ).toMatchObject({ ok: false, status: 422 });
    expect(
      check(
        'request.release',
        request({ status: 'closed', staffOwnerId: 'staff-1' }),
        owner,
      ),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it('allows hand-off only for the current owner and prevents handing off to self', () => {
    const owner: ActorView = { kind: 'staff', userId: 'staff-1' };
    expect(
      check('request.handoff', request({ staffOwnerId: 'staff-1' }), owner),
    ).toEqual({ ok: true });
    expect(
      check('request.handoff', request({ staffOwnerId: null }), owner),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      check('request.handoff', request({ staffOwnerId: 'staff-1' }), owner, {
        toStaffId: 'staff-1',
        note: 'Shift this request',
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: 'You already own this request.',
    });
    expect(
      check('request.handoff', request({ staffOwnerId: 'staff-1' }), owner, {
        toStaffId: 'staff-2',
        note: 'no',
      }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it('allows request.reassign holders to reassign open requests and checks owner revision and note', () => {
    const operations: ActorView = {
      kind: 'staff',
      userId: 'ops-1',
      permissions: new Set(['request.reassign']),
    };
    expect(check('request.reassign', request(), operations)).toEqual({
      ok: true,
    });
    expect(
      check('request.reassign', request({ status: 'cancelled' }), operations),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check('request.reassign', request(), { kind: 'staff' }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      check('request.reassign', request(), operations, {
        staffId: 'staff-2',
        expectedOwnerId: 'staff-1',
        note: 'Rebalance now',
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check(
        'request.reassign',
        request({ staffOwnerId: 'staff-2' }),
        operations,
        {
          staffId: 'staff-2',
          expectedOwnerId: 'staff-2',
          note: 'Rebalance now',
        },
      ),
    ).toMatchObject({
      ok: false,
      status: 409,
      message: 'This staff member already owns the request.',
    });
    expect(
      check('request.reassign', request(), operations, {
        staffId: 'staff-2',
        expectedOwnerId: null,
        note: 'no',
      }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it('exposes ownership actions and preserves the composed request.update guard', () => {
    const owner: ActorView = {
      kind: 'staff',
      userId: 'staff-1',
      canOwn: true,
      permissions: new Set([
        'request.claim',
        'request.review',
        'request.reassign',
      ]),
    };
    const actions = allowedActions(request(), owner, now, {}, REQUEST_GUARDS);
    expect(actions).toContain('request.claim');
    expect(actions).toContain('request.reassign');
    expect(actions).toContain('request.update');

    const currentOwnerActions = allowedActions(
      request({ staffOwnerId: 'staff-1' }),
      owner,
      now,
      {},
      REQUEST_GUARDS,
    );
    expect(currentOwnerActions).toContain('request.release');
    expect(currentOwnerActions).toContain('request.handoff');
    expect(currentOwnerActions).not.toContain('request.claim');
  });
});
