import type { GuardRegistry } from './allowed-actions';
import {
  conflict,
  isStaffWith,
  NO_LONGER_OPEN,
  ok,
  staffDenied,
} from './guards/common';
import type { DomainGuard } from './guards/types';
import { TERMINAL } from './statuses';

// Escalating raises a question for staff; it changes no scope, assignment,
// schedule, quote, progress or issue, so only a terminal request refuses it.
const escalate: DomainGuard<unknown> = (snap, actor) => {
  if (!isStaffWith(actor, 'request.escalate')) return staffDenied();
  return TERMINAL.has(snap.status) ? conflict(NO_LONGER_OPEN) : ok;
};

// Whether an open escalation exists, who raised it and its target need the
// escalation rows; the service checks them after the lock.
const resolve: DomainGuard<unknown> = (_snap, actor) =>
  isStaffWith(actor, 'request.escalation.resolve') ? ok : staffDenied();

export const ESCALATION_GUARDS: GuardRegistry = {
  'request.escalate': escalate,
  'request.escalation.resolve': resolve,
};
