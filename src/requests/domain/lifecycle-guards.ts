import type { GuardRegistry } from './allowed-actions';
import type { DomainGuard, GuardResult } from './guards/types';

const yes: GuardResult = { ok: true };
const no = (message = 'This action is not available for your account.'): GuardResult => ({ ok: false, status: 403, code: 'FORBIDDEN', message });
const staff = (permission: string) => (actor: { kind: string; permissions?: ReadonlySet<string> }) => actor.kind === 'staff' && actor.permissions?.has(permission);

export const LIFECYCLE_GUARDS: GuardRegistry = {
  'schedule.propose': ((snap, actor) => staff('schedule.manage')(actor) && ['ready_to_schedule', 'scheduled'].includes(snap.status) ? yes : no()) as DomainGuard,
  'schedule.respond': ((snap, actor) => ((actor.kind === 'customer' && actor.userId === snap.ownerId) || (actor.kind === 'provider' && actor.userId === snap.currentProviderUserId)) && snap.currentSchedule?.status === 'proposed' ? yes : no()) as DomainGuard,
  'schedule.requestChange': ((snap, actor) => ((actor.kind === 'customer' && actor.userId === snap.ownerId) || (actor.kind === 'provider' && actor.userId === snap.currentProviderUserId)) && snap.currentSchedule?.status === 'confirmed' ? yes : no()) as DomainGuard,
  'progress.add': ((snap, actor) => actor.kind === 'provider' && actor.userId === snap.currentProviderUserId && ['scheduled', 'in_progress', 'blocked'].includes(snap.status) && !snap.hold ? yes : no()) as DomainGuard,
  'progress.review': ((snap, actor) => staff('progress.review')(actor) && snap.pendingUpdates.length > 0 ? yes : no()) as DomainGuard,
  'progress.addOnBehalf': ((snap, actor) => staff('progress.review')(actor) && ['scheduled', 'in_progress', 'blocked'].includes(snap.status) ? yes : no()) as DomainGuard,
  'request.hold': ((snap, actor) => staff('progress.review')(actor) && ['scheduled', 'in_progress'].includes(snap.status) ? yes : no()) as DomainGuard,
  'request.releaseHold': ((snap, actor) => staff('progress.review')(actor) && snap.status === 'blocked' && Boolean(snap.hold) ? yes : no()) as DomainGuard,
  'noshow.record': ((snap, actor) => staff('dispatch.manage')(actor) && snap.currentSchedule?.status === 'confirmed' ? yes : no()) as DomainGuard,
  'noshow.confirm': ((snap, actor) => staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'open' ? yes : no()) as DomainGuard,
  'noshow.dismiss': ((snap, actor) => staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'open' ? yes : no()) as DomainGuard,
  'noshow.correct': ((snap, actor) => staff('dispatch.manage')(actor) && snap.latestNoShow?.status === 'confirmed' ? yes : no()) as DomainGuard,
};
