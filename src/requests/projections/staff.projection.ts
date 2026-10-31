import type { RequestDetailDto } from '../dto/request-detail.dto';
import {
  commonProjection,
  cancellationProjection,
  completionProjection,
  effectiveDates,
  groupProjection,
  issueProjection,
  jsonObject,
  noShowProjection,
  scheduleProjection,
  type ProjectionContext,
} from './projection.helpers';
import { answerSnapshots } from '../domain/answers';
import {
  payoutSuggestion,
  staffContributionView,
  staffQuoteView,
} from './quote.projection';

export function staffProjection(context: ProjectionContext): RequestDetailDto {
  const { row, actor } = context;
  const canSeeContact =
    actor.staff?.permissions.has('view.customer_contact') ?? false;
  const canSeePricing = actor.staff?.permissions.has('view.pricing') ?? false;
  const quote = row.quotes[0];
  const currentAssignment = row.assignments
    .filter((item) => item.status === 'accepted')
    .at(-1);
  const dates = effectiveDates(
    row.service,
    row.startDate,
    jsonObject(row.details),
    row.answers,
  );
  const answers = answerSnapshots(row.answers);
  const schedules = scheduleProjection(context);
  return {
    ...commonProjection(context),
    contactInBrief: context.snapshot.contactInBrief ?? false,
    title: row.title,
    service: row.service,
    locationId: row.locationId,
    locationPath: context.snapshot.locationPath,
    locationLabel: context.snapshot.locationLabel,
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
      : hideContactDetails(
          jsonObject(row.details),
          answers.filter(({ sensitive }) => sensitive).map(({ key }) => key),
        ),
    servicePath: row.servicePath,
    answers: canSeeContact
      ? answers
      : answers.filter(({ sensitive }) => !sensitive),
    customerName: row.customerName,
    ownerId: row.ownerId,
    ...groupProjection(context),
    staffOwnerId: row.staffOwnerId,
    ...(context.customerRequestLimit
      ? { customerRequestLimit: context.customerRequestLimit }
      : {}),
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
      note: item.note ?? '',
      offeredAt: item.offeredAt,
      expiresAt: item.expiresAt,
      score: item.score,
    })),
    quote: quote
      ? staffQuoteView(quote, {
          canSeePricing,
          userId: actor.userId,
          canApprove: actor.staff?.permissions.has('quote.approve') ?? false,
          isSuperAdmin: actor.staff?.isSuperAdmin ?? false,
          payoutSuggestion: payoutSuggestion(
            row.contributions,
            currentAssignment?.id,
          ),
        })
      : null,
    contributions: row.contributions.map((item) =>
      staffContributionView(item, canSeePricing),
    ),
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
  sensitiveKeys: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).flatMap(([key, value]) => {
      if (
        sensitiveKeys.includes(key) ||
        /address|access|gate|entry|contact|phone/i.test(key)
      )
        return [];
      if (Array.isArray(value)) {
        return [
          [
            key,
            value.map((item: unknown): unknown =>
              item !== null && typeof item === 'object' && !Array.isArray(item)
                ? hideContactDetails(
                    item as Record<string, unknown>,
                    sensitiveKeys,
                  )
                : item,
            ),
          ],
        ];
      }
      if (value !== null && typeof value === 'object') {
        return [
          [
            key,
            hideContactDetails(value as Record<string, unknown>, sensitiveKeys),
          ],
        ];
      }
      return [[key, value]];
    }),
  );
}
