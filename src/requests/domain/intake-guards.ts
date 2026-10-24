import type { DomainGuard, GuardResult } from './guards/types';

const allowed = (): GuardResult => ({ ok: true });
const denied = (message: string): GuardResult => ({
  ok: false,
  status: 409,
  code: 'STATE_CONFLICT',
  message,
});

const hasPermission = (
  permissions: ReadonlySet<string> | undefined,
  ...names: string[]
) => names.some((name) => permissions?.has(name));

export const canClarify: DomainGuard<unknown> = (snap, actor) => {
  if (
    actor.kind !== 'staff' ||
    !hasPermission(actor.permissions, 'request.clarify', 'request.review')
  )
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Your staff role does not allow this action.',
    };
  return snap.status === 'submitted'
    ? allowed()
    : denied('This request has moved beyond intake review.');
};

export const canReview: DomainGuard<unknown> = (snap, actor) => {
  if (
    actor.kind !== 'staff' ||
    !hasPermission(actor.permissions, 'request.review')
  )
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Your staff role does not allow this action.',
    };
  if (snap.status !== 'submitted')
    return denied('This request has moved beyond intake review.');
  if (snap.customerStanding === 'suspended')
    return denied(
      'This customer is suspended. Resolve the suspension before approving.',
    );
  if (snap.pendingCancellation)
    return denied(
      'A cancellation request is waiting. Decide it before approving.',
    );
  return allowed();
};

export const canReject: DomainGuard<unknown> = (snap, actor) => {
  if (
    actor.kind !== 'staff' ||
    !hasPermission(actor.permissions, 'request.review')
  )
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Your staff role does not allow this action.',
    };
  return snap.status === 'submitted'
    ? allowed()
    : denied('Only a request still in intake review can be rejected.');
};

export const canFreeCancel: DomainGuard<unknown> = (snap, actor) => {
  if (actor.kind !== 'customer' || actor.userId !== snap.ownerId)
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'This action is not available for your account type.',
    };
  const hasOffer = snap.assignments.some(
    ({ status }) =>
      status === 'offered' ||
      status === 'pending_approval' ||
      status === 'accepted' ||
      status === 'completed',
  );
  return snap.status === 'submitted' &&
    snap.intake.state !== 'approved' &&
    !hasOffer
    ? allowed()
    : denied('This request can no longer be cancelled for free.');
};

export const INTAKE_GUARDS = {
  'request.clarify': canClarify,
  'request.review': canReview,
  'request.reject': canReject,
  'request.cancel': canFreeCancel,
} satisfies Record<string, DomainGuard<unknown>>;
