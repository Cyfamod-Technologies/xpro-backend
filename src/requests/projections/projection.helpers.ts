import type { ActorContext } from '../../platform/actor/actor.types';
import { toActorView } from '../actor-view';
import { allowedActions } from '../domain/allowed-actions';
import { customerRefundStatus } from '../domain/cancellation-rules';
import { statusLabel, type LabelValues } from '../domain/labels';
import {
  deriveStage,
  nextActor,
  viewerNextActor,
  type RequestStage,
} from '../domain/stage';
import type { RequestSnapshot } from '../domain/snapshot';
import type { LoadedRequest } from '../snapshot.loader';
import type { CustomerRequestLimit } from '../open-request-limit';
import type { RequestGroupView } from '../request-group-view';
import type { RequestDetailDto, RequestRole } from '../dto/request-detail.dto';
import type { SettingsSnapshot } from '../domain/guards/types';
import { REQUEST_GUARDS } from '../domain/request-guard-registry';
import { answerSnapshots } from '../domain/answers';

export type ProjectionContext = {
  row: LoadedRequest;
  snapshot: RequestSnapshot;
  actor: ActorContext;
  role: RequestRole;
  now: Date;
  settings: SettingsSnapshot;
  /** Staff detail only (04 §11.2): the request owner's open-request allowance. */
  customerRequestLimit?: CustomerRequestLimit;
  /** Customer and staff detail only (04 §4.1a). Left out, the projection adds neither `group` nor `siblings`. */
  groupView?: RequestGroupView;
};

export function scheduleProjection(
  context: ProjectionContext,
  assignmentId?: string,
) {
  return context.row.schedules
    .filter(
      (schedule) => !assignmentId || schedule.assignmentId === assignmentId,
    )
    .map((schedule) => ({
      id: schedule.id,
      status: schedule.status,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      note: schedule.note ?? '',
      customer: schedule.customer,
      provider: schedule.provider,
      confirmedAt: schedule.confirmedAt,
    }));
}

export function issueProjection(context: ProjectionContext) {
  return context.row.issues.map((issue) => ({
    id: issue.id,
    status: issue.status,
    note: issue.note,
    outcome: issue.resolvedWith,
    createdAt: issue.raisedAt,
  }));
}

export function cancellationProjection(context: ProjectionContext) {
  return context.row.cancellations.map((item) => ({
    id: item.id,
    status: item.status,
    reasonCode: item.reasonCode,
    note: item.note,
    refundStatus: customerRefundStatus(
      item.refunds.map(({ status }) => status),
    ),
    createdAt: item.createdAt,
  }));
}

export function noShowProjection(context: ProjectionContext) {
  return context.row.noShows.map((item) => ({
    id: item.id,
    scheduleId: item.scheduleId,
    status: item.status,
    version: item.version,
    note: item.note,
    createdAt: item.detectedAt,
  }));
}

export function completionProjection(context: ProjectionContext) {
  const { row } = context;
  if (
    !row.reportApprovedAt &&
    !row.confirmDueAt &&
    !row.acknowledgedAt &&
    !row.defectsWindowEndsAt
  )
    return null;
  return {
    reportedAt: row.reportApprovedAt,
    confirmationDueAt: row.confirmDueAt,
    acknowledgedAt: row.acknowledgedAt,
    defectsWindowEndsAt: row.defectsWindowEndsAt,
  };
}

export type CommonProjectionContext = Omit<ProjectionContext, 'row'> & {
  row: Pick<LoadedRequest, 'version' | 'status' | 'createdAt' | 'updatedAt'>;
};

export function commonProjection(
  context: CommonProjectionContext,
): RequestDetailDto {
  const { row, snapshot, actor, role, now, settings } = context;
  const stage = deriveStage(snapshot, now);
  const values = labelValues(snapshot, settings, stage);
  return {
    id: snapshot.number,
    version: row.version,
    status: row.status,
    stage,
    statusLabel: statusLabel(stage, role, values, snapshot),
    nextActor: viewerNextActor(nextActor(snapshot, stage, now), role),
    allowedActions: allowedActions(
      snapshot,
      toActorView(actor),
      now,
      settings,
      REQUEST_GUARDS,
    ),
    overlays: {
      cancellation: snapshot.pendingCancellation
        ? role === 'customer'
          ? 'Cancellation requested — awaiting XPro'
          : role === 'staff'
            ? 'Cancellation to decide'
            : null
        : null,
      flag: role === 'staff' ? (snapshot.flag ?? null) : null,
      suspendedParties:
        role === 'staff'
          ? [
              ...(snapshot.customerStanding === 'suspended'
                ? ['Customer suspended']
                : []),
              ...(snapshot.providerStanding === 'suspended'
                ? ['Provider suspended']
                : []),
            ]
          : [],
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function groupProjection(
  context: ProjectionContext,
): Pick<RequestDetailDto, 'group' | 'siblings'> {
  return context.groupView
    ? { group: context.groupView.group, siblings: context.groupView.siblings }
    : {};
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

export function numberKobo(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

const MONEY_ITEM_KEYS = new Set(['unitPrice', 'amount', 'total', 'lineTotal']);

/** Quote and costing lines with every money field as a kobo `number`, never a string or bigint (A.2 rule 7). */
export function itemsWithNumberMoney(
  items: unknown,
): Array<Record<string, unknown>> {
  return jsonArray(items).map((item) =>
    Object.fromEntries(
      Object.entries(item).map(([key, value]) => [
        key,
        MONEY_ITEM_KEYS.has(key) &&
        (typeof value === 'string' || typeof value === 'bigint')
          ? Number(value)
          : value,
      ]),
    ),
  );
}

/** The lines without any money, for staff who lack `view.pricing`. */
export function itemsWithoutMoney(
  items: unknown,
): Array<{ description: unknown; quantity: unknown }> {
  return jsonArray(items).map(({ description, quantity }) => ({
    description,
    quantity,
  }));
}

function labelValues(
  snapshot: RequestSnapshot,
  settings: SettingsSnapshot,
  stage: RequestStage,
): LabelValues {
  const values: LabelValues = {};
  if (snapshot.currentAssignment) {
    values.n = snapshot.currentAssignment.attempt ?? 1;
    const maxAttempts = settings['assignment.maxAutoAttempts'];
    values.max = typeof maxAttempts === 'number' ? maxAttempts : 3;
    values.time = new Intl.DateTimeFormat('en-NG', {
      timeZone: 'Africa/Lagos',
      hour: 'numeric',
      minute: '2-digit',
    }).format(snapshot.currentAssignment.expiresAt);
  }
  // `{n}` is the attempt in offer labels and the quote version in quote labels (04 §5.3).
  if (stage === 'quote_revision' && snapshot.latestQuote)
    values.n = snapshot.latestQuote.version;
  else if (stage === 'quote_with_customer') {
    const sent = snapshot.latestSentQuote ?? snapshot.latestQuote;
    if (sent) values.n = sent.version;
  }
  if (snapshot.defectsWindowEndsAt) {
    values.date = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(snapshot.defectsWindowEndsAt);
  }
  if (snapshot.hold) values.kind = snapshot.hold.kind.replaceAll('_', ' ');
  return values;
}

export function effectiveDates(
  service: string,
  startDate: string | null,
  details: Record<string, unknown>,
  answers: unknown = [],
) {
  const dated = answerSnapshots(answers).filter(({ dateRole }) => dateRole);
  if (dated.length) {
    const dateOf = (role: 'start' | 'end') =>
      stringValue(dated.find((answer) => answer.dateRole === role)?.value);
    return {
      effectiveStartDate: dateOf('start') ?? startDate,
      effectiveEndDate: dateOf('end'),
    };
  }
  const effectiveStartDate =
    service === 'Waste Management'
      ? stringValue(details.pickupDate)
      : service === 'Procurement'
        ? stringValue(details.deliveryDate)
        : service === 'Facility Management'
          ? (stringValue(details.visitDate) ?? startDate)
          : startDate;
  return {
    effectiveStartDate,
    effectiveEndDate:
      service === 'Hiring' ? stringValue(details.endDate) : null,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
