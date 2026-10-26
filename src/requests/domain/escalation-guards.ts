import type { GuardRegistry } from './allowed-actions';
import {
  conflict,
  fail,
  firstFailure,
  invalid,
  isStaffWith,
  NO_LONGER_OPEN,
  objectInput,
  ok,
  staffDenied,
  trimmed,
} from './guards/common';
import type { DomainGuard } from './guards/types';
import { TERMINAL } from './statuses';

// 02 §6.10 (all new messages).
export const ESCALATION_MESSAGES = {
  noteRequired: 'Add a note explaining the escalation.',
  resolutionNoteRequired: 'Add a resolution note.',
  ownRaise: 'Someone else must resolve an escalation you raised.',
  superAdminOnly: 'Only a super admin can resolve this escalation.',
  notOpen: 'This escalation is no longer open.',
  alreadyOpen: (target: string) =>
    `This request already has an open escalation to ${target}.`,
} as const;

// Escalating raises a question for staff; it changes no scope, assignment,
// schedule, quote, progress or issue, so only a terminal request refuses it.
// 02 §6.10 order: the note, an open request, then one open escalation per target.
const escalate: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'request.escalate')) return staffDenied();
  const body = objectInput<{ note?: unknown; to?: unknown }>(input);
  return firstFailure(
    body && trimmed(body.note).length < 5
      ? invalid(ESCALATION_MESSAGES.noteRequired)
      : null,
    TERMINAL.has(snap.status) ? conflict(NO_LONGER_OPEN) : null,
    body && snap.openEscalations?.some((open) => open.to === body.to)
      ? conflict(ESCALATION_MESSAGES.alreadyOpen(String(body.to)))
      : null,
  );
};

// Settling an escalation checks no request state: it must work on a request
// that has since closed. The row checks need the open escalations in the snapshot.
const resolve: DomainGuard<unknown> = (snap, actor, input) => {
  if (!isStaffWith(actor, 'request.escalation.resolve')) return staffDenied();
  const body = objectInput<{ escalationId?: unknown; note?: unknown }>(input);
  if (!body) return ok;
  const open = snap.openEscalations?.find(
    (escalation) => escalation.id === body.escalationId,
  );
  if (!open) return conflict(ESCALATION_MESSAGES.notOpen);
  return firstFailure(
    open.raisedBy && open.raisedBy === actor.userId && !actor.isSuperAdmin
      ? fail(403, 'FORBIDDEN', ESCALATION_MESSAGES.ownRaise)
      : null,
    open.to === 'super_admin' && !actor.isSuperAdmin
      ? fail(403, 'FORBIDDEN', ESCALATION_MESSAGES.superAdminOnly)
      : null,
    trimmed(body.note).length < 5
      ? invalid(ESCALATION_MESSAGES.resolutionNoteRequired)
      : null,
  );
};

export const ESCALATION_GUARDS: GuardRegistry = {
  'request.escalate': escalate,
  'request.escalation.resolve': resolve,
};
