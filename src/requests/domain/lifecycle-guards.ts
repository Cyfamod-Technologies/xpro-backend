import type { GuardRegistry } from './allowed-actions';
import type { DomainGuard, GuardResult } from './guards/types';

const yes: GuardResult = { ok: true };
const no = (
  message = 'This action is not available for your account.',
): GuardResult => ({ ok: false, status: 403, code: 'FORBIDDEN', message });
const staff =
  (permission: string) =>
  (actor: { kind: string; permissions?: ReadonlySet<string> }) =>
    actor.kind === 'staff' && actor.permissions?.has(permission);

export const LIFECYCLE_GUARDS: GuardRegistry = {
  'schedule.propose': (snap, actor) =>
    staff('schedule.manage')(actor) &&
    ['ready_to_schedule', 'scheduled'].includes(snap.status)
      ? yes
      : no(),
  'schedule.respond': (snap, actor) =>
    ((actor.kind === 'customer' && actor.userId === snap.ownerId) ||
      (actor.kind === 'provider' &&
        actor.userId === snap.currentProviderUserId)) &&
    snap.currentSchedule?.status === 'proposed'
      ? yes
      : no(),
  'schedule.requestChange': (snap, actor) =>
    ((actor.kind === 'customer' && actor.userId === snap.ownerId) ||
      (actor.kind === 'provider' &&
        actor.userId === snap.currentProviderUserId)) &&
    snap.currentSchedule?.status === 'confirmed'
      ? yes
      : no(),
  'progress.add': (snap, actor) =>
    actor.kind === 'provider' &&
    actor.userId === snap.currentProviderUserId &&
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status) &&
    !snap.hold
      ? yes
      : no(),
  'progress.review': (snap, actor) =>
    staff('progress.review')(actor) && snap.pendingUpdates.length > 0
      ? yes
      : no(),
  'progress.addOnBehalf': (snap, actor) =>
    staff('progress.review')(actor) &&
    ['scheduled', 'in_progress', 'blocked'].includes(snap.status)
      ? yes
      : no(),
  'request.hold': (snap, actor) =>
    staff('progress.review')(actor) &&
    ['scheduled', 'in_progress'].includes(snap.status)
      ? yes
      : no(),
  'request.releaseHold': (snap, actor) =>
    staff('progress.review')(actor) &&
    snap.status === 'blocked' &&
    Boolean(snap.hold)
      ? yes
      : no(),
  'noshow.record': (snap, actor) =>
    staff('dispatch.manage')(actor) &&
    snap.currentSchedule?.status === 'confirmed'
      ? yes
      : no(),
  'noshow.confirm': (snap, actor) =>
    staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'open'
      ? yes
      : no(),
  'noshow.dismiss': (snap, actor) =>
    staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'open'
      ? yes
      : no(),
  'noshow.correct': (snap, actor) =>
    staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'confirmed'
      ? yes
      : no(),
  'completion.respond': (snap, actor) =>
    actor.kind === 'customer' &&
    actor.userId === snap.ownerId &&
    snap.status === 'completion_pending' &&
    !snap.openIssues.length
      ? yes
      : no(),
  'completion.confirmOnBehalf': (snap, actor) =>
    staff('issue.resolve')(actor) &&
    snap.status === 'completion_pending' &&
    !snap.openIssues.length
      ? yes
      : no(),
  'issue.raise': (snap, actor) =>
    actor.kind === 'customer' &&
    actor.userId === snap.ownerId &&
    snap.status === 'acknowledged'
      ? yes
      : no(),
  'issue.resolve': (snap, actor) =>
    staff('issue.resolve')(actor) && snap.openIssues.length > 0 ? yes : no(),
  'issue.accept': (snap, actor) =>
    staff('issue.resolve')(actor) &&
    snap.openIssues.some((item) => item.status === 'open')
      ? yes
      : no(),
  'issue.escalate': (snap, actor) =>
    staff('issue.resolve')(actor) && snap.openIssues.length > 0 ? yes : no(),
  'request.close': (snap, actor) =>
    staff('request.close')(actor) &&
    snap.status === 'acknowledged' &&
    !snap.openIssues.length
      ? yes
      : no(),
  'cancellation.request': (snap, actor) =>
    actor.kind === 'customer' &&
    actor.userId === snap.ownerId &&
    !snap.pendingCancellation &&
    !['closed', 'cancelled', 'rejected', 'cancelling'].includes(snap.status)
      ? yes
      : no(),
  'cancellation.withdraw': (snap, actor) =>
    actor.kind === 'customer' &&
    actor.userId === snap.ownerId &&
    snap.pendingCancellation
      ? yes
      : no(),
  'cancellation.decide': (snap, actor) =>
    staff('request.cancel')(actor) && snap.pendingCancellation ? yes : no(),
};
