import type { ActorContext } from '../../platform/actor/actor.types';

export const AUTO_CLAIM_COMMANDS: ReadonlySet<string> = new Set([
  'request.review',
  'request.clarify',
  'request.update',
  'assignment.auto',
  'assignment.offer',
  'assignment.review',
  'assignment.withdraw',
  'assignment.replace',
  'noshow.record',
  'schedule.propose',
  'progress.review',
  'issue.resolve',
  'cancellation.decide',
]);

/** 02 §6.5: `cancellation.decide` claims only when it rejects; an approval ends the request. */
const advancesWorkflow = (command: string, input: unknown): boolean =>
  command !== 'cancellation.decide' ||
  (typeof input === 'object' &&
    input !== null &&
    (input as { approve?: unknown }).approve === false);

export function mayAutoClaim(
  actor: ActorContext,
  command: string,
  unclaimed: boolean,
  open: boolean,
  input?: unknown,
): boolean {
  return (
    AUTO_CLAIM_COMMANDS.has(command) &&
    advancesWorkflow(command, input) &&
    unclaimed &&
    open &&
    actor.kind === 'staff' &&
    actor.accountActive &&
    actor.staff?.status === 'active' &&
    actor.staff.canOwn &&
    !actor.staff.isSuperAdmin
  );
}
