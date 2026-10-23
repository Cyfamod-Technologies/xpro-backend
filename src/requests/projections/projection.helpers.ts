import type { ActorContext } from '../../platform/actor/actor.types';
import { allowedActions } from '../domain/allowed-actions';
import { statusLabel, type LabelValues } from '../domain/labels';
import { deriveStage, nextActor } from '../domain/stage';
import type { RequestSnapshot } from '../domain/snapshot';
import type { LoadedRequest } from '../snapshot.loader';
import type { RequestDetailDto, RequestRole } from '../dto/request-detail.dto';
import type { SettingsSnapshot } from '../domain/guards/types';
import { REQUEST_GUARDS } from '../domain/request-guard-registry';

export type ProjectionContext = {
  row: LoadedRequest;
  snapshot: RequestSnapshot;
  actor: ActorContext;
  role: RequestRole;
  now: Date;
  settings: SettingsSnapshot;
};

export function commonProjection(context: ProjectionContext): RequestDetailDto {
  const { row, snapshot, actor, role, now, settings } = context;
  const stage = deriveStage(snapshot, now);
  const values = labelValues(snapshot, settings);
  return {
    id: snapshot.number,
    version: row.version,
    status: row.status,
    stage,
    statusLabel: statusLabel(stage, role, values, snapshot),
    nextActor: nextActor(snapshot, stage, now),
    allowedActions: allowedActions(snapshot, {
      kind: actor.kind,
      userId: actor.userId,
      platformRoles: actor.platformRoles,
      permissions: actor.staff?.permissions,
      canOwn: actor.staff?.canOwn,
    }, now, settings, REQUEST_GUARDS),
    overlays: {
      cancellation: snapshot.pendingCancellation
        ? role === 'customer' ? 'Cancellation requested — awaiting XPro' : role === 'staff' ? 'Cancellation to decide' : null
        : null,
      flag: role === 'staff' ? snapshot.flag ?? null : null,
      suspendedParties: role === 'staff' ? [
        ...(snapshot.customerStanding === 'suspended' ? ['Customer suspended'] : []),
        ...(snapshot.providerStanding === 'suspended' ? ['Provider suspended'] : []),
      ] : [],
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function jsonArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

export function numberKobo(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function labelValues(snapshot: RequestSnapshot, settings: SettingsSnapshot): LabelValues {
  const values: LabelValues = {};
  if (snapshot.currentAssignment) {
    values.n = snapshot.currentAssignment.attempt ?? 1;
    const maxAttempts = settings['assignment.maxAutoAttempts'];
    values.max = typeof maxAttempts === 'number' ? maxAttempts : 3;
    values.time = new Intl.DateTimeFormat('en-NG', {
      timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit',
    }).format(snapshot.currentAssignment.expiresAt);
  }
  if (snapshot.defectsWindowEndsAt) {
    values.date = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(snapshot.defectsWindowEndsAt);
  }
  if (snapshot.hold) values.kind = snapshot.hold.kind.replaceAll('_', ' ');
  return values;
}

export function effectiveDates(service: string, startDate: string | null, details: Record<string, unknown>) {
  const effectiveStartDate = service === 'Waste management'
    ? stringValue(details.pickupDate)
    : service === 'Procurement'
      ? stringValue(details.deliveryDate)
      : service === 'Facility management'
        ? stringValue(details.visitDate) ?? startDate
        : startDate;
  return {
    effectiveStartDate,
    effectiveEndDate: service === 'Hire' ? stringValue(details.endDate) : null,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
