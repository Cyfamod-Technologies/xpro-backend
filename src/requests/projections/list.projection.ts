import type { ActorContext } from '../../platform/actor/actor.types';
import type { RequestSnapshot } from '../domain/snapshot';
import type { RequestRole } from '../dto/request-detail.dto';
import type { LoadedRequest } from '../snapshot.loader';
import { commonProjection } from './projection.helpers';
import type { SettingsSnapshot } from '../domain/guards/types';

export function listProjection(
  row: LoadedRequest,
  snapshot: RequestSnapshot,
  actor: ActorContext,
  now: Date,
  settings: SettingsSnapshot,
): Record<string, unknown> {
  const role: RequestRole = actor.kind === 'system' || (actor.kind === 'staff' && actor.staff?.status === 'active')
    ? 'staff'
    : snapshot.ownerId === actor.userId
      ? 'customer'
      : actor.platformRoles.includes('provider')
        ? 'provider'
        : 'customer';
  const providerOwnsAcceptedAssignment = snapshot.currentProviderUserId === actor.userId &&
    (snapshot.currentAssignment?.status === 'accepted' || snapshot.currentAssignment?.status === 'completed');
  const showTitle = role !== 'provider' || providerOwnsAcceptedAssignment;
  return {
    ...commonProjection({ row, snapshot, actor, role, now, settings }),
    ...(showTitle ? { title: row.title } : {}),
    service: row.service,
  };
}
