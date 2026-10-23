import type { ActorContext } from '../../platform/actor/actor.types';
import { mayAutoClaim } from './auto-claim';

function staffActor(roles: string[], canOwn: boolean, isSuperAdmin = false): ActorContext {
  return {
    userId: 'staff-1', kind: 'staff', displayName: 'Staff', platformRoles: ['staff'], accountActive: true,
    staff: {
      status: 'active', roles: roles as never, permissions: new Set(), canOwn, isSuperAdmin, permVersion: 1,
    },
  };
}

describe('mayAutoClaim', () => {
  it('lets an owner-capable Operations actor claim on intake approval', () => {
    expect(mayAutoClaim(staffActor(['operations'], true), 'request.review', true, true)).toBe(true);
  });

  it('does not auto-claim for a super admin', () => {
    expect(mayAutoClaim(staffActor(['super_admin'], true, true), 'request.review', true, true)).toBe(false);
  });

  it('does not auto-claim for Client relations on clarification because they cannot own', () => {
    expect(mayAutoClaim(staffActor(['client_relations'], false), 'request.clarify', true, true)).toBe(false);
  });

  it('does not auto-claim system actions or requests that are already owned or closed', () => {
    const operations = staffActor(['operations'], true);
    expect(mayAutoClaim({ ...operations, kind: 'system', userId: null }, 'request.review', true, true)).toBe(false);
    expect(mayAutoClaim(operations, 'request.review', false, true)).toBe(false);
    expect(mayAutoClaim(operations, 'request.review', true, false)).toBe(false);
  });

  it('does not auto-claim on commands outside the approved list', () => {
    expect(mayAutoClaim(staffActor(['operations'], true), 'request.reject', true, true)).toBe(false);
    expect(mayAutoClaim(staffActor(['operations'], true), 'request.hold', true, true)).toBe(false);
  });
});
