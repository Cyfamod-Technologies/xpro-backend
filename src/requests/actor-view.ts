import type { ActorContext } from '../platform/actor/actor.types';
import type { ActorView } from './domain/snapshot';

/** What the pure request guards see of an actor; staff permissions are empty unless the staff account is active. */
export function toActorView(actor: ActorContext): ActorView {
  return {
    kind: actor.kind,
    userId: actor.userId,
    platformRoles: actor.platformRoles,
    permissions: actor.staff?.permissions,
    canOwn: actor.staff?.canOwn,
  };
}
