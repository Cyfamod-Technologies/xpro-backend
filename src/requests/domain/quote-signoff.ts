import { conflict, invalid, ok } from './guards/common';
import type { GuardResult } from './guards/types';

export const LAST_EDITOR_MESSAGE =
  'You edited this quote last. Another approver must sign it off.';
export const SELF_APPROVAL_REASON_MESSAGE =
  'Add a reason for approving your own quote.';

/**
 * 04 §6.11 sign-off: with a threshold set, a quote at or above it is published
 * directly only by a `quote.approve` holder who is not the last editor (SAF-3).
 */
export function requiresSignOff(input: {
  threshold: unknown;
  total: number | bigint;
  holdsApprove: boolean;
  lastEditedBy: string;
  actorId: string | null;
}): boolean {
  const threshold = Number(input.threshold);
  if (input.threshold == null || !Number.isFinite(threshold)) return false;
  if (Number(input.total) < threshold) return false;
  return !(input.holdsApprove && input.lastEditedBy !== input.actorId);
}

/**
 * 04 §6.11 approve rows 3 and 4 (02 §6.12): the last editor may approve their
 * own quote only as the single active super admin, and only with a reason.
 */
export function selfApprovalFailure(input: {
  lastEditedBy: string;
  actorId: string;
  isSuperAdmin: boolean;
  activeSuperAdminIds: readonly string[];
  reason?: string;
}): GuardResult {
  if (input.lastEditedBy !== input.actorId) return ok;
  const sole =
    input.isSuperAdmin &&
    input.activeSuperAdminIds.length === 1 &&
    input.activeSuperAdminIds[0] === input.actorId;
  if (!sole) return conflict(LAST_EDITOR_MESSAGE);
  return input.reason?.trim() ? ok : invalid(SELF_APPROVAL_REASON_MESSAGE);
}
