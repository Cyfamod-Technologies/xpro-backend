import type { ActorView, RequestSnapshot } from './snapshot';
import type { DomainGuard, SettingsSnapshot } from './guards/types';

export type GuardRegistry = Readonly<Record<string, DomainGuard<unknown>>>;

export function allowedActions(
  snap: RequestSnapshot,
  actor: ActorView,
  now: Date,
  settings: SettingsSnapshot,
  registry: GuardRegistry = {},
): string[] {
  return Object.entries(registry)
    .filter(([, guard]) => guard(snap, actor, undefined, now, settings).ok)
    .map(([action]) => action);
}
