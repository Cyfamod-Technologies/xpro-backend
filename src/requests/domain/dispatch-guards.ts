import type { GuardRegistry } from './allowed-actions';
import type { DomainGuard } from './guards/types';

const staff = (permission: string) => (permissions: ReadonlySet<string> | undefined) => Boolean(permissions?.has(permission));
const command = (test: (status: string) => boolean, permission: string): DomainGuard<unknown> => (snap, actor) =>
  actor.kind === 'staff' && staff(permission)(actor.permissions) && test(snap.status)
    ? { ok: true }
    : { ok: false, status: 403, code: 'FORBIDDEN', message: 'Your staff role does not allow this action.' };

export const DISPATCH_GUARDS: GuardRegistry = {
  'dispatch.setMode': command((status) => status === 'under_review', 'dispatch.manage'),
  'dispatch.manage': command((status) => status === 'under_review', 'dispatch.manage'),
  'assignment.auto': command((status) => status === 'under_review', 'dispatch.manage'),
  'assignment.offer': command((status) => status === 'under_review', 'dispatch.manage'),
  'assignment.review': command((status) => status === 'under_review', 'dispatch.manage'),
  'assignment.withdraw': command((status) => status === 'under_review', 'dispatch.manage'),
  'assignment.replace': command((status) => status === 'matched' || status === 'quoted', 'dispatch.manage'),
  'request.shareDetails': command((status) => status !== 'closed' && status !== 'cancelled' && status !== 'rejected', 'dispatch.manage'),
};
