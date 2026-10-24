import type { RequestDetailDto } from '../dto/request-detail.dto';
import {
  commonProjection,
  cancellationProjection,
  completionProjection,
  effectiveDates,
  issueProjection,
  jsonArray,
  jsonObject,
  noShowProjection,
  numberKobo,
  scheduleProjection,
  type ProjectionContext,
} from './projection.helpers';

export function staffProjection(context: ProjectionContext): RequestDetailDto {
  const { row, actor } = context;
  const canSeeContact =
    actor.staff?.permissions.has('view.customer_contact') ?? false;
  const canSeePricing = actor.staff?.permissions.has('view.pricing') ?? false;
  const quote = row.quotes[0];
  const dates = effectiveDates(
    row.service,
    row.startDate,
    jsonObject(row.details),
  );
  const schedules = scheduleProjection(context);
  return {
    ...commonProjection(context),
    title: row.title,
    service: row.service,
    cityId: row.cityId,
    districtId: row.districtId,
    ...(canSeeContact
      ? {
          address: row.address,
          phone: row.phone,
          contactMethod: row.contactMethod,
        }
      : {}),
    description: row.description,
    budget: canSeePricing ? Number(row.budget) : null,
    startDate: row.startDate,
    ...dates,
    details: canSeeContact
      ? jsonObject(row.details)
      : hideContactDetails(jsonObject(row.details)),
    customerName: row.customerName,
    ownerId: row.ownerId,
    staffOwnerId: row.staffOwnerId,
    claimedAt: row.claimedAt,
    unclaimedSince: row.unclaimedSince,
    ownershipVersion: row.ownershipVersion,
    intake: {
      state: row.intakeState,
      clarificationCount: row.clarificationCount,
    },
    attachments: row.attachments.map(({ uploadId, sharedWithProvider }) => ({
      ...(context.snapshot.attachmentInfo?.find(
        ({ id }) => id === uploadId,
      ) ?? {
        id: uploadId,
        name: '',
        size: 0,
        type: '',
        uploadedAt: row.createdAt,
      }),
      sharedWithProvider,
    })),
    assignment: row.assignments.map((item) => ({
      id: item.id,
      providerId: item.providerId,
      providerUserId: item.providerUserId,
      status: item.status,
      source: item.source,
      attempt: item.attempt,
      note: item.note,
      offeredAt: item.offeredAt,
      expiresAt: item.expiresAt,
      score: item.score,
    })),
    quote: quote
      ? {
          version: quote.version,
          status: quote.status,
          total: canSeePricing ? numberKobo(quote.total) : null,
          payoutAmount: canSeePricing ? numberKobo(quote.payoutAmount) : null,
          items: canSeePricing
            ? quote.items
            : jsonArray(quote.items).map(({ description, quantity }) => ({
                description,
                quantity,
              })),
          ...(canSeePricing ? { note: quote.note } : {}),
          amountsHidden: !canSeePricing,
        }
      : null,
    ...(canSeePricing
      ? {
          contributions: row.contributions.map((item) => ({
            providerId: item.providerId,
            total: Number(item.total),
            items: item.items,
            note: item.note,
          })),
        }
      : {}),
    dispatch: {
      mode: row.dispatchMode,
      autoAttempts: row.autoAttempts,
      needsAssignmentReason: row.needsAssignmentReason,
      runs: row.runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        at: run.at,
        outcome: run.outcome,
      })),
    },
    schedules,
    schedule:
      schedules.find(
        (item) => item.status === 'proposed' || item.status === 'confirmed',
      ) ??
      schedules[0] ??
      null,
    issues: issueProjection(context),
    cancellations: cancellationProjection(context),
    noShows: noShowProjection(context),
    completion: completionProjection(context),
  };
}

function hideContactDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).flatMap(([key, value]) => {
      if (/address|access|gate|entry|contact|phone/i.test(key)) return [];
      if (Array.isArray(value)) {
        return [
          [
            key,
            value.map((item: unknown): unknown =>
              item !== null && typeof item === 'object' && !Array.isArray(item)
                ? hideContactDetails(item as Record<string, unknown>)
                : item,
            ),
          ],
        ];
      }
      if (value !== null && typeof value === 'object') {
        return [[key, hideContactDetails(value as Record<string, unknown>)]];
      }
      return [[key, value]];
    }),
  );
}
