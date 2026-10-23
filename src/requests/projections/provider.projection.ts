import type { RequestDetailDto } from '../dto/request-detail.dto';
import { commonProjection, effectiveDates, jsonArray, jsonObject, type ProjectionContext } from './projection.helpers';

export function providerProjection(context: ProjectionContext): RequestDetailDto {
  const { row, snapshot, actor } = context;
  const assignment = row.assignments.filter((item) => item.providerUserId === actor.userId &&
    ['offered', 'pending_approval', 'accepted', 'completed'].includes(item.status)).at(-1);
  if (!assignment) return commonProjection(context);

  const dto = commonProjection(context);
  const details = jsonObject(row.details);
  const dates = effectiveDates(row.service, row.startDate, details);
  const locked = row.schedules.some((schedule) => schedule.status === 'confirmed' && schedule.assignmentId === assignment.id);
  const accepted = assignment.status === 'accepted' || assignment.status === 'completed';
  const quote = row.quotes.find((item) => item.status === 'accepted') ?? row.quotes.find((item) => item.status === 'sent');
  const ownContribution = row.contributions.find((item) => item.assignmentId === assignment.id);
  const ownPayout = quote?.payoutAssignmentId === assignment.id ? quote.payoutAmount : null;
  const scope = quote ? jsonArray(quote.items).map((item) => ({
    description: String(item.description ?? ''),
    quantity: Number(item.quantity ?? 0),
  })) : undefined;

  if (assignment.status === 'offered') {
    return {
      ...dto,
      service: row.service,
      cityId: row.cityId,
      districtId: row.districtId,
      cityName: snapshot.cityName,
      districtName: snapshot.districtName,
      ...dates,
      details: offerDetails(details),
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
  const sharedFields = new Set(Array.isArray(shared.fields)
    ? shared.fields.filter((key): key is string => typeof key === 'string')
    : []);
  const fields: RequestDetailDto = {
    ...dto,
    service: row.service,
    cityId: row.cityId,
    districtId: row.districtId,
    cityName: snapshot.cityName,
    districtName: snapshot.districtName,
    ...dates,
    details: locked ? details : safeSharedDetails(details, shared),
    assignment: { status: assignment.status },
    attachments: row.attachments
      .filter(({ uploadId, sharedWithProvider }) => locked || sharedWithProvider || isAttachmentShared(assignment.sharedDetails, uploadId))
      .map(({ uploadId, sharedWithProvider }) => ({
        ...(snapshot.attachmentInfo?.find(({ id }) => id === uploadId) ?? { id: uploadId, name: '', size: 0, type: '', uploadedAt: row.createdAt }),
        sharedWithProvider,
      })),
    quote: scope ? {
      scope,
      ...(ownPayout === null ? {} : { payoutAmount: Number(ownPayout) }),
    } : null,
    contributions: ownContribution ? [{ items: ownContribution.items, note: ownContribution.note }] : [],
  };
  if (accepted) fields.title = row.title;
  if (locked || sharedFields.has('address')) fields.address = row.address;
  if (locked || shared.description === true || sharedFields.has('description')) fields.description = row.description;
  return fields;
}

function offerDetails(details: Record<string, unknown>): Record<string, unknown> {
  const optionKeys = new Set([
    'designType', 'delivery', 'workType', 'hireType', 'trade', 'skill', 'operator', 'category',
    'propertyType', 'serviceNeeds', 'wasteType',
  ]);
  return Object.fromEntries(Object.entries(details).filter(([key, value]) =>
    optionKeys.has(key) || (['area', 'quantity'].includes(key) && typeof value === 'number' && Number.isFinite(value)),
  ));
}

function safeSharedDetails(details: Record<string, unknown>, shared: Record<string, unknown>) {
  const selected = Array.isArray(shared.fields)
    ? new Set(shared.fields.filter((key): key is string => typeof key === 'string'))
    : new Set<string>();
  return Object.fromEntries(Object.entries(details).filter(([key]) => selected.has(key)));
}

function isAttachmentShared(value: unknown, uploadId: string): boolean {
  const shared = jsonObject(value);
  return Array.isArray(shared.attachmentIds) && shared.attachmentIds.includes(uploadId);
}
