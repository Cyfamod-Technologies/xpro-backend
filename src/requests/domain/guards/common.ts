import type { ActorView, RequestSnapshot } from '../snapshot';
import { TERMINAL } from '../statuses';
import type { ErrorCode, GuardFailure, GuardResult } from './types';

export const ok: GuardResult = { ok: true };

export const fail = (
  status: GuardFailure['status'],
  code: ErrorCode,
  message: string,
): GuardFailure => ({ ok: false, status, code, message });

export const STAFF_DENIED = 'Your staff role does not allow this action.';
export const ACCOUNT_DENIED =
  'This action is not available for your account type.';
// new message: not in spec
export const NO_LONGER_OPEN = 'This request is no longer open.';

export const staffDenied = () => fail(403, 'FORBIDDEN', STAFF_DENIED);
export const accountDenied = () => fail(403, 'FORBIDDEN', ACCOUNT_DENIED);
export const conflict = (message: string) =>
  fail(409, 'STATE_CONFLICT', message);
export const invalid = (message: string) =>
  fail(422, 'VALIDATION_ERROR', message);
export const paymentInProgress = (message: string) =>
  fail(409, 'PAYMENT_IN_PROGRESS', message);

export const hasPermission = (actor: ActorView, ...names: string[]) =>
  names.some((name) => actor.permissions?.has(name) === true);

export const isStaffWith = (actor: ActorView, ...names: string[]) =>
  actor.kind === 'staff' && hasPermission(actor, ...names);

/** A staff member who also holds the customer or provider platform role acts in that role on their own requests (04 §6.3). */
const actsAs = (actor: ActorView, role: 'customer' | 'provider') =>
  actor.kind === role || actor.platformRoles?.includes(role) === true;

export const isProviderActor = (actor: ActorView) => actsAs(actor, 'provider');

export const isOwner = (snap: RequestSnapshot, actor: ActorView) =>
  actsAs(actor, 'customer') && !!actor.userId && actor.userId === snap.ownerId;

export const isCurrentProvider = (snap: RequestSnapshot, actor: ActorView) =>
  actsAs(actor, 'provider') &&
  !!actor.userId &&
  actor.userId === snap.currentProviderUserId;

/** The first guard check wins; a failing result is returned as is. */
export function firstFailure(
  ...results: Array<GuardResult | null | undefined>
): GuardResult {
  for (const result of results) if (result && !result.ok) return result;
  return ok;
}

export const objectInput = <T extends object>(input: unknown): T | null =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as T)
    : null;

export const trimmed = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Terminal statuses and `cancelling` refuse every command that changes scope,
 * assignment, schedule, quote, progress or issues (04 §6.18). It is the first
 * check of each such guard. Reads and refund or payment settlement never call it.
 */
export function assertOpen(snap: RequestSnapshot): GuardResult {
  return TERMINAL.has(snap.status) || snap.status === 'cancelling'
    ? conflict(NO_LONGER_OPEN)
    : ok;
}
