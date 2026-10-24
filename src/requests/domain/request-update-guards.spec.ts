import { allowedActions } from './allowed-actions';
import { REQUEST_GUARDS } from './request-guard-registry';
import { UPDATE_GUARDS } from './request-update-guards';
import type { ActorView, RequestSnapshot } from './snapshot';

const request = (overrides: Partial<RequestSnapshot> = {}) =>
  ({
    id: 'request-1',
    number: 'XPR-00001',
    ownerId: 'customer-1',
    status: 'submitted',
    intake: { state: 'pending' },
    assignments: [],
    quotes: [],
    ...overrides,
  }) as RequestSnapshot;

const check = (snapshot: RequestSnapshot, actor: ActorView) =>
  UPDATE_GUARDS['request.update'](
    snapshot,
    actor,
    undefined,
    new Date('2026-10-23T10:00:00.000Z'),
    {},
  );

describe('request.update guard', () => {
  it('allows the owner to edit submitted requests pending review or awaiting clarification', () => {
    const owner: ActorView = { kind: 'customer', userId: 'customer-1' };
    expect(check(request(), owner)).toEqual({ ok: true });
    expect(
      check(request({ intake: { state: 'clarification' } }), owner),
    ).toEqual({ ok: true });
  });

  it('rejects customers who do not own the request or whose edit window has closed', () => {
    expect(
      check(request(), { kind: 'customer', userId: 'customer-2' }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      check(request({ status: 'under_review' }), {
        kind: 'customer',
        userId: 'customer-1',
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check(request({ intake: { state: 'approved' } }), {
        kind: 'customer',
        userId: 'customer-1',
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it('allows permitted staff edits only before provider acceptance', () => {
    const reviewer: ActorView = {
      kind: 'staff',
      permissions: new Set(['request.review']),
    };
    expect(check(request({ status: 'under_review' }), reviewer)).toEqual({
      ok: true,
    });
    expect(
      check(
        request({
          assignments: [
            { status: 'offered', attempt: 1, expiresAt: new Date() },
          ],
        }),
        reviewer,
      ),
    ).toEqual({ ok: true });
    expect(
      check(
        request({
          assignments: [
            { status: 'pending_approval', attempt: 1, expiresAt: new Date() },
          ],
        }),
        reviewer,
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check(
        request({
          assignments: [
            { status: 'accepted', attempt: 1, expiresAt: new Date() },
          ],
        }),
        reviewer,
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      check(
        request({
          quotes: [
            {
              status: 'accepted',
              version: 1,
              approvalRequestedAt: null,
              validUntil: null,
              payoutAmount: null,
            },
          ],
        }),
        reviewer,
      ),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it('uses the owner edit window for a staff actor who also has the customer role', () => {
    const dualRoleOwner: ActorView = {
      kind: 'staff',
      userId: 'customer-1',
      platformRoles: ['staff', 'customer'],
      permissions: new Set(['request.review']),
    };
    expect(check(request(), dualRoleOwner)).toEqual({ ok: true });
    expect(
      check(request({ status: 'under_review' }), dualRoleOwner),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it('requires review permission and is exposed through the composed action registry', () => {
    expect(
      check(request(), {
        kind: 'staff',
        permissions: new Set(['request.clarify']),
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      check(request(), { kind: 'provider', userId: 'provider-1' }),
    ).toMatchObject({
      ok: false,
      status: 403,
      message: 'This action is not available for your account type.',
    });
    expect(
      allowedActions(
        request(),
        { kind: 'staff', permissions: new Set(['request.review']) },
        new Date(),
        {},
        REQUEST_GUARDS,
      ),
    ).toContain('request.update');
  });
});
