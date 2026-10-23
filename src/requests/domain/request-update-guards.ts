import type { DomainGuard } from './guards/types';

const canUpdateRequest: DomainGuard<unknown> = (snap, actor) => {
  const isCustomer = actor.kind === 'customer' || actor.platformRoles?.includes('customer') === true;
  const isOwner = isCustomer && actor.userId === snap.ownerId;
  if (isOwner) {
    return snap.status === 'submitted' && (snap.intake.state === 'pending' || snap.intake.state === 'clarification')
      ? { ok: true }
      : { ok: false, status: 409, code: 'STATE_CONFLICT', message: 'XPro has already approved this request. Send changes to XPro in Messages.' };
  }

  if (actor.kind === 'customer')
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'This action is not available for your account type.' };

  if (actor.kind !== 'staff')
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'This action is not available for your account type.' };

  if (!actor.permissions?.has('request.review'))
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Your staff role does not allow this action.' };

  if ((snap.status !== 'submitted' && snap.status !== 'under_review')
    || snap.assignments.some(({ status }) => status === 'pending_approval' || status === 'accepted')
    || snap.quotes.some(({ status }) => status === 'accepted'))
    return { ok: false, status: 409, code: 'STATE_CONFLICT', message: 'A provider has already accepted this request. Agree changes with the customer and reflect them in the quote.' };

  return { ok: true };
};

export const UPDATE_GUARDS = {
  'request.update': canUpdateRequest,
} satisfies Record<string, DomainGuard<unknown>>;
