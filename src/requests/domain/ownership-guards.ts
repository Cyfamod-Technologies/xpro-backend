import type { DomainGuard, GuardResult } from './guards/types';
import type { ActorView } from './snapshot';

type ReleaseInput = { note?: unknown; expectedOwnerId?: unknown };
type HandoffInput = { note?: unknown; toStaffId?: unknown };
type ReassignInput = {
  note?: unknown;
  staffId?: unknown;
  expectedOwnerId?: unknown;
};

const OPEN_STATUSES = new Set([
  'submitted',
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
  'cancelling',
]);

const denied = (message: string): GuardResult => ({
  ok: false,
  status: 403,
  code: 'FORBIDDEN',
  message,
});
const conflict = (message: string): GuardResult => ({
  ok: false,
  status: 409,
  code: 'STATE_CONFLICT',
  message,
});
const invalid = (message: string): GuardResult => ({
  ok: false,
  status: 422,
  code: 'VALIDATION_ERROR',
  message,
});
const open = (status: string) => OPEN_STATUSES.has(status);
const isInput = <T extends object>(value: unknown): value is T =>
  typeof value === 'object' && value !== null;
const hasPermission = (actor: ActorView, permission: string) =>
  actor.permissions?.has(permission) === true;
const noteIsValid = (note: unknown) =>
  typeof note === 'string' &&
  note.trim().length >= 5 &&
  note.trim().length <= 500;
const ownerChangedMessage =
  "This request's owner has changed. Refresh and retry.";

export const canClaim: DomainGuard<unknown> = (snap, actor) => {
  if (
    actor.kind !== 'staff' ||
    !hasPermission(actor, 'request.claim') ||
    actor.canOwn !== true
  )
    return denied('Your staff role does not allow this action.');
  if (!open(snap.status))
    return conflict(
      'Closed, cancelled or rejected requests cannot be claimed.',
    );
  if ((snap.staffOwnerId ?? null) !== null)
    return conflict('This request already has an owner.');
  return { ok: true };
};

export const canRelease: DomainGuard<unknown> = (snap, actor, input) => {
  if (actor.kind !== 'staff')
    return denied('This action is not available for your account type.');
  const isOwner = !!actor.userId && actor.userId === snap.staffOwnerId;
  if (!isOwner && !hasPermission(actor, 'request.reassign'))
    return denied('Only the owner or Operations can release this request.');
  if (!open(snap.status)) return conflict('This request is closed.');
  if (isInput<ReleaseInput>(input)) {
    if (input.expectedOwnerId !== snap.staffOwnerId)
      return conflict(ownerChangedMessage);
    if (!noteIsValid(input.note))
      return invalid('Add a note for whoever picks this up.');
  }
  return { ok: true };
};

export const canHandoff: DomainGuard<unknown> = (snap, actor, input) => {
  if (
    actor.kind !== 'staff' ||
    !actor.userId ||
    actor.userId !== snap.staffOwnerId
  )
    return denied('Only the owner can hand off this request.');
  if (!open(snap.status)) return conflict('This request is closed.');
  if (isInput<HandoffInput>(input)) {
    if (input.toStaffId === actor.userId)
      return conflict('You already own this request.');
    if (!noteIsValid(input.note)) return invalid('Add a hand-off note.');
  }
  return { ok: true };
};

export const canReassign: DomainGuard<unknown> = (snap, actor, input) => {
  if (actor.kind !== 'staff' || !hasPermission(actor, 'request.reassign'))
    return denied('Your staff role does not allow this action.');
  if (!open(snap.status)) return conflict('This request is closed.');
  if (isInput<ReassignInput>(input)) {
    if (input.expectedOwnerId !== snap.staffOwnerId)
      return conflict(ownerChangedMessage);
    if (input.staffId === snap.staffOwnerId)
      return conflict('This staff member already owns the request.');
    if (!noteIsValid(input.note))
      return invalid('Add a reason for reassigning this request.');
  }
  return { ok: true };
};

export const OWNERSHIP_GUARDS = {
  'request.claim': canClaim,
  'request.release': canRelease,
  'request.handoff': canHandoff,
  'request.reassign': canReassign,
} satisfies Record<string, DomainGuard<unknown>>;
