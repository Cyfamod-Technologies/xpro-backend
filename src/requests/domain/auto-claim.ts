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

export function mayAutoClaim(
  actor: ActorContext,
  command: string,
  unclaimed: boolean,
  open: boolean,
): boolean {
  return (
    AUTO_CLAIM_COMMANDS.has(command) &&
    unclaimed &&
    open &&
    actor.kind === 'staff' &&
    actor.accountActive &&
    actor.staff?.status === 'active' &&
    actor.staff.canOwn &&
    !actor.staff.isSuperAdmin
  );
}
