import type { RequestDetailDto } from '../dto/request-detail.dto';
import {
  commonProjection,
  effectiveDates,
  groupProjection,
  cancellationProjection,
  completionProjection,
  issueProjection,
  jsonObject,
  scheduleProjection,
  type ProjectionContext,
} from './projection.helpers';
import { answerSnapshots } from '../domain/answers';
import { customerCurrentQuote, customerQuoteView } from './quote.projection';

export function customerProjection(
  context: ProjectionContext,
): RequestDetailDto {
  const { row } = context;
  const dto = commonProjection(context);
  const currentQuote = customerCurrentQuote(row.quotes);
  const assignment = row.assignments
    .filter((item) => item.status === 'accepted' || item.status === 'completed')
    .at(-1);
  const schedule =
    row.schedules.find((item) => item.status === 'confirmed') ??
    row.schedules[0];
  const dates = effectiveDates(
    row.service,
    row.startDate,
    jsonObject(row.details),
    row.answers,
  );
  return {
    ...dto,
    title: row.title,
    service: row.service,
    cityId: row.cityId,
    districtId: row.districtId,
    cityName: context.snapshot.cityName,
    districtName: context.snapshot.districtName,
    address: row.address,
    phone: row.phone,
    contactMethod: row.contactMethod,
    description: row.description,
    budget: Number(row.budget),
    startDate: row.startDate,
    ...dates,
    details: jsonObject(row.details),
    servicePath: row.servicePath,
    answers: answerSnapshots(row.answers),
    customerName: row.customerName,
    ...groupProjection(context),
    intake: {
      state: row.intakeState,
      clarificationCount: row.clarificationCount,
    },
    assignment: assignment ? { status: assignment.status } : null,
    ...(assignment &&
    (context.snapshot.currentAssignment?.status === 'accepted' ||
      context.snapshot.currentAssignment?.status === 'completed')
      ? { provider: providerCard(context.snapshot.providerCard) }
      : {}),
    quote: currentQuote ? customerQuoteView(currentQuote) : null,
    schedule: schedule
      ? {
          id: schedule.id,
          status: schedule.status,
          startAt: schedule.startAt,
          endAt: schedule.endAt,
          note: schedule.note ?? '',
          customer: schedule.customer,
          provider: schedule.provider,
          confirmedAt: schedule.confirmedAt,
        }
      : null,
    schedules: scheduleProjection(context),
    issues: issueProjection(context),
    cancellations: cancellationProjection(context),
    completion: completionProjection(context),
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
  };
}

function providerCard(
  card: ProjectionContext['snapshot']['providerCard'],
): NonNullable<RequestDetailDto['provider']> | null {
  if (!card) return null;
  const fallbackName = [
    card.firstName,
    card.lastName ? `${card.lastName[0]}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    businessName:
      card.businessName?.trim() || `${fallbackName} (${card.trade})`,
    trade: card.trade,
    verified: card.verification === 'approved',
  };
}
