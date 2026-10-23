import type { StaffPermission } from '../../staff/staff-permissions';
import { AppError } from '../errors/app-error';
import type { ActorContext } from './actor.types';

export const WRONG_ACCOUNT_TYPE_MESSAGE =
  'This action is not available for your account type.';
export const STAFF_NOT_ACTIVE_MESSAGE = 'Your staff account is not active.';
export const STAFF_ROLE_DENIED_MESSAGE =
  'Your staff role does not allow this action.';

/** Replaces the 04 §2.1 text for callers that must keep their own wording. */
export type GuardMessages = {
  accountType?: string;
  inactive?: string;
  denied?: string;
};

const forbidden = (message: string) => new AppError(403, 'FORBIDDEN', message);

export function requireCustomer(actor: ActorContext): void {
  if (!actor.platformRoles.includes('customer'))
    throw forbidden(WRONG_ACCOUNT_TYPE_MESSAGE);
}

export function requireProvider(actor: ActorContext): void {
  if (!actor.platformRoles.includes('provider'))
    throw forbidden(WRONG_ACCOUNT_TYPE_MESSAGE);
}

/** Order: account type, then staff status (04 §2.1, 02 §2.6). */
export function requireActiveStaff(
  actor: ActorContext,
  messages: GuardMessages = {},
): asserts actor is ActorContext & {
  staff: NonNullable<ActorContext['staff']>;
} {
  if (!actor.staff)
    throw forbidden(messages.accountType ?? WRONG_ACCOUNT_TYPE_MESSAGE);
  if (actor.staff.status !== 'active')
    throw forbidden(messages.inactive ?? STAFF_NOT_ACTIVE_MESSAGE);
}

export function requirePermission(
  actor: ActorContext,
  permission: StaffPermission,
  messages: GuardMessages = {},
): void {
  requireActiveStaff(actor, messages);
  if (!actor.staff.permissions.has(permission))
    throw forbidden(messages.denied ?? STAFF_ROLE_DENIED_MESSAGE);
}

export function requireAnyPermission(
  actor: ActorContext,
  permissions: readonly StaffPermission[],
  messages: GuardMessages = {},
): void {
  requireActiveStaff(actor, messages);
  if (
    !permissions.some((permission) => actor.staff.permissions.has(permission))
  )
    throw forbidden(messages.denied ?? STAFF_ROLE_DENIED_MESSAGE);
}
