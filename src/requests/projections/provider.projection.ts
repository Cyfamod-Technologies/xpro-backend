import type { RequestDetailDto } from '../dto/request-detail.dto';
import { answerSnapshots, type AnswerSnapshot } from '../domain/answers';
import {
  commonProjection,
  effectiveDates,
  completionProjection,
  jsonObject,
  issueProjection,
  scheduleProjection,
  type ProjectionContext,
} from './projection.helpers';
import {
  providerContributionView,
  providerCurrentQuote,
  providerQuoteView,
} from './quote.projection';

export function providerProjection(
  context: ProjectionContext,
): RequestDetailDto {
  const { row, snapshot, actor } = context;
  const assignment = row.assignments
    .filter(
      (item) =>
        item.providerUserId === actor.userId &&
        ['offered', 'pending_approval', 'accepted', 'completed'].includes(
          item.status,
        ),
    )
    .at(-1);
  if (!assignment) return commonProjection(context);

  const dto = commonProjection(context);
  const details = jsonObject(row.details);
  const dates = effectiveDates(
    row.service,
    row.startDate,
    details,
    row.answers,
  );
  const answers = answerSnapshots(row.answers);
  const locked = row.schedules.some(
    (schedule) =>
      schedule.status === 'confirmed' &&
      schedule.assignmentId === assignment.id,
  );
  const accepted =
    assignment.status === 'accepted' || assignment.status === 'completed';
  const schedules = scheduleProjection(context, assignment.id);
  const quote = providerCurrentQuote(row.quotes);
  const ownContribution = row.contributions.find(
    (item) => item.assignmentId === assignment.id,
  );

  if (assignment.status === 'offered') {
    return {
      ...dto,
      service: row.service,
      cityId: row.cityId,
      districtId: row.districtId,
      cityName: snapshot.cityName,
      districtName: snapshot.districtName,
      ...dates,
      details: offerDetails(details, answers),
      servicePath: row.servicePath,
      answers: visibleAnswers(answers, offerDetails(details, answers)),
      assignment: {
        id: assignment.id,
        status: assignment.status,
        expiresAt: assignment.expiresAt,
        note: assignment.note,
        offerBrief: row.offerBrief,
      },
    };
  }

  const shared = jsonObject(assignment.sharedDetails);
  const sharedFields = new Set(
    Array.isArray(shared.fields)
      ? shared.fields.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const visibleDetails = locked
    ? details
    : {
        ...offerDetails(details, answers),
        ...safeSharedDetails(details, shared),
      };
  const fields: RequestDetailDto = {
    ...dto,
    service: row.service,
    cityId: row.cityId,
    districtId: row.districtId,
    cityName: snapshot.cityName,
    districtName: snapshot.districtName,
    ...dates,
    details: visibleDetails,
    servicePath: row.servicePath,
    answers: visibleAnswers(answers, visibleDetails),
    assignment: {
      id: assignment.id,
      status: assignment.status,
      note: assignment.note,
      offerBrief: row.offerBrief,
    },
    schedules,
    schedule:
      schedules.find((item) => item.status === 'confirmed') ??
      schedules[0] ??
      null,
    issues: issueProjection(context),
    completion: completionProjection(context),
    attachments: row.attachments
      .filter(
        ({ uploadId, sharedWithProvider }) =>
          locked ||
          sharedWithProvider ||
          isAttachmentShared(assignment.sharedDetails, uploadId),
      )
      .map(({ uploadId, sharedWithProvider }) => ({
        ...(snapshot.attachmentInfo?.find(({ id }) => id === uploadId) ?? {
          id: uploadId,
          name: '',
          size: 0,
          type: '',
          uploadedAt: row.createdAt,
        }),
        sharedWithProvider,
      })),
    quote: quote ? providerQuoteView(quote, [assignment.id]) : null,
    contributions: ownContribution
      ? [providerContributionView(ownContribution)]
      : [],
  };
  if (accepted) fields.title = row.title;
  if (locked || sharedFields.has('address')) fields.address = row.address;
  if (locked || shared.description === true || sharedFields.has('description'))
    fields.description = row.description;
  return fields;
}

function visibleAnswers(
  answers: readonly AnswerSnapshot[],
  details: Record<string, unknown>,
): AnswerSnapshot[] {
  return answers.filter(({ key }) => key in details);
}

const OFFER_ANSWER_TYPES = new Set([
  'yes_no',
  'single_choice',
  'multiple_choice',
  'number',
]);

function offerDetails(
  details: Record<string, unknown>,
  answers: readonly AnswerSnapshot[] = [],
): Record<string, unknown> {
  if (answers.length)
    return Object.fromEntries(
      answers
        .filter(
          ({ sensitive, type }) => !sensitive && OFFER_ANSWER_TYPES.has(type),
        )
        .map(({ key, value }) => [key, value]),
    );
  const optionKeys = new Set([
    'designType',
    'delivery',
    'workType',
    'hireType',
    'trade',
    'skill',
    'operator',
    'category',
    'propertyType',
    'serviceNeeds',
    'wasteType',
  ]);
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key, value]) =>
        optionKeys.has(key) ||
        (['area', 'quantity'].includes(key) &&
          typeof value === 'number' &&
          Number.isFinite(value)),
    ),
  );
}

function safeSharedDetails(
  details: Record<string, unknown>,
  shared: Record<string, unknown>,
) {
  const selected = Array.isArray(shared.fields)
    ? new Set(
        shared.fields.filter((key): key is string => typeof key === 'string'),
      )
    : new Set<string>();
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => selected.has(key)),
  );
}

function isAttachmentShared(value: unknown, uploadId: string): boolean {
  const shared = jsonObject(value);
  return (
    Array.isArray(shared.attachmentIds) &&
    shared.attachmentIds.includes(uploadId)
  );
}
