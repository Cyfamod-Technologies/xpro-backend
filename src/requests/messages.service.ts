import { ConflictException, Injectable } from '@nestjs/common';
import { MessageChannel, UploadPurpose, UploadStatus } from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { RequestCommandRunner } from './command-runner';
import { canSendMessage } from './domain/message-guards';
import { parseRequestId } from './domain/statuses';

const TERMINAL = new Set(['closed', 'cancelled', 'rejected']);
const CURRENT_ASSIGNMENTS = new Set(['offered', 'pending_approval', 'accepted', 'completed']);
const CHANNEL_PERMISSION: Record<'customer' | 'provider' | 'internal', 'message.customer' | 'message.provider' | 'message.internal'> = {
  customer: 'message.customer', provider: 'message.provider', internal: 'message.internal',
};

type MessageChannelName = 'customer' | 'provider' | 'internal';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(user: RequestUser, ref: string, channel?: MessageChannelName, providerId?: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findVisibleRequest(ref, actor);
    if (!request) throw opaqueNotFound();
    const assignment = await this.currentAssignment(request.id);
    const providerScope = actor.kind === 'provider' ? assignment?.providerId : (providerId ?? assignment?.providerId);
    const requestedChannels = channel ? [channel] : (['customer', 'provider', 'internal'] as const);
    const visible: MessageChannelName[] = [];
    for (const candidate of requestedChannels) {
      if (candidate === 'provider' && (!providerScope || !request.assignments.some((item) => item.providerId === providerScope))) continue;
      if (canReadChannel(actor, request.ownerId, candidate, providerScope, assignment)) visible.push(candidate);
    }
    if (!visible.length) throw forbiddenChannel();
    const nonProviderChannels = visible.filter((candidate) => candidate !== 'provider');
    const channelWhere = visible.includes('provider') && providerScope
      ? { OR: [
          ...(nonProviderChannels.length ? [{ channel: { in: nonProviderChannels } }] : []),
          { channel: 'provider' as const, providerId: providerScope },
        ] }
      : { channel: { in: visible } };
    const rows = await this.prisma.requestMessage.findMany({
      where: { requestId: request.id, ...channelWhere },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const files = rows.length ? await this.prisma.upload.findMany({
      where: { entityType: 'message', entityId: { in: rows.map(({ id }) => id) }, status: UploadStatus.attached },
      select: { id: true, entityId: true, fileName: true, contentType: true, size: true, createdAt: true },
    }) : [];
    const authorIds = [...new Set(rows.map(({ authorId }) => authorId).filter((id): id is string => Boolean(id)))];
    const authors = authorIds.length ? await this.prisma.user.findMany({
      where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true, name: true, email: true },
    }) : [];
    const authorById = new Map(authors.map((author) => [author.id, [author.firstName, author.lastName].filter(Boolean).join(' ').trim() || author.name || author.email]));
    return rows.map((message) => ({
      id: message.id,
      channel: message.channel,
      providerId: message.providerId,
      text: message.text,
      createdAt: message.createdAt,
      author: {
        role: message.authorRole,
        label: renderAuthor(message.authorRole, message.authorId, actor, authorById),
      },
      attachments: files.filter((file) => file.entityId === message.id).map(({ id, fileName, contentType, size }) => ({
        id, name: fileName, type: contentType, size,
      })),
    }));
  }

  async send(user: RequestUser, ref: string, dto: {
    channel: MessageChannelName; text?: string; attachments?: Array<{ id: string }>; providerId?: string;
  }, originalUrl: string, idempotencyKey?: string) {
    const actor = await this.actors.resolve(user.id);
    const text = dto.text?.trim() ?? '';
    const uploadIds = (dto.attachments ?? []).map(({ id }) => id);
    if (!text && uploadIds.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'Add a message or attach a file.');
    if (text.length > 4000) throw new AppError(422, 'VALIDATION_ERROR', 'Keep messages under 4,000 characters.');
    if (new Set(uploadIds).size !== uploadIds.length) throw new AppError(409, 'STATE_CONFLICT', "One of your files didn't finish uploading. Remove it and try again.");
    if (!actor.accountActive || (actor.kind === 'staff' && actor.staff?.status !== 'active')) throw forbiddenChannel();
    if (actor.kind === 'staff' && !actor.staff?.permissions.has(CHANNEL_PERMISSION[dto.channel])) throw forbiddenChannel();
    if (actor.kind === 'customer' && dto.channel !== 'customer') throw forbiddenChannel();
    if (actor.kind === 'provider' && dto.channel !== 'provider') throw forbiddenChannel();

    const hash = this.idempotency.hashRequest('POST', originalUrl, { ...dto, text, attachments: uploadIds });
    return this.runner.run({
      command: 'message.send', actor, requestRef: ref,
      ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
    }, async (context) => {
      if (TERMINAL.has(context.snap.status)) throw new ConflictException('Messages are closed for this request.');
      const request = await context.tx.serviceRequest.findUnique({
        where: { id: context.snap.id },
        select: { ownerId: true, intakeState: true, number: true, assignments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, providerId: true, providerUserId: true, status: true } } },
      });
      if (!request) throw opaqueNotFound();
      const current = request.assignments[0] && CURRENT_ASSIGNMENTS.has(request.assignments[0].status) ? request.assignments[0] : null;
      const providerId = dto.channel === 'provider' ? (dto.providerId ?? current?.providerId ?? null) : null;
      const guard = canSendMessage(context.snap, {
        kind: actor.kind, userId: actor.userId, permissions: actor.staff?.permissions,
      }, { channel: dto.channel, providerId }, context.now, context.settings);
      if (!guard.ok) throw new AppError(guard.status, guard.code, guard.message);
      if (!canWriteChannel(actor, request.ownerId, dto.channel, providerId, current)) throw forbiddenChannel();

      const message = await context.tx.requestMessage.create({ data: {
        requestId: context.snap.id,
        channel: dto.channel as MessageChannel,
        providerId,
        authorId: actor.userId,
        authorRole: actor.kind,
        text,
      } });
      if (uploadIds.length) {
        const uploads = await context.tx.upload.findMany({
          where: { id: { in: uploadIds }, ownerId: actor.userId!, purpose: UploadPurpose.message_attachment, status: UploadStatus.ready, expiresAt: { gt: context.now } },
          select: { id: true, size: true },
        });
        if (uploads.length !== uploadIds.length) throw new ConflictException("One of your files didn't finish uploading. Remove it and try again.");
        if (uploads.reduce((total, upload) => total + upload.size, 0) > 25 * 1024 * 1024)
          throw new ConflictException('Keep the combined file size under 25 MB.');
        const attached = await context.tx.upload.updateMany({
          where: { id: { in: uploadIds }, ownerId: actor.userId!, purpose: UploadPurpose.message_attachment, status: UploadStatus.ready, expiresAt: { gt: context.now } },
          data: { status: UploadStatus.attached, entityType: 'message', entityId: message.id, attachedAt: context.now },
        });
        if (attached.count !== uploadIds.length) throw new ConflictException("One of your files didn't finish uploading. Remove it and try again.");
      }
      context.audit('Message sent', { resourceType: 'request_message', resourceId: message.id, changes: { channel: dto.channel, attachmentCount: uploadIds.length } });
      context.notify('request.message_update', { requestCode: `XPR-${String(request.number).padStart(5, '0')}`, channel: dto.channel, providerId });

      if (dto.channel === 'customer' && actor.userId === request.ownerId && request.intakeState === 'clarification') {
        await context.tx.serviceRequest.update({ where: { id: context.snap.id }, data: { intakeState: 'pending' } });
        context.timers.stop([TimerKinds.T6Reminder48h, TimerKinds.T6Staff5d, TimerKinds.T6FinalWarning, TimerKinds.T6AutoCancel]);
        context.audit('Clarification answered');
        context.notify('request.clarification_answered', { requestCode: context.snap.number });
      }
      return { status: 201 };
    });
  }

  private async findVisibleRequest(ref: string, actor: ActorContext) {
    const sequence = parseRequestId(ref);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref);
    if (sequence === null && !isUuid) return null;
    const request = await this.prisma.serviceRequest.findFirst({
      where: { OR: [...(isUuid ? [{ id: ref }] : []), ...(sequence !== null ? [{ number: sequence }] : [])] },
      select: { id: true, ownerId: true, assignments: { orderBy: { createdAt: 'desc' }, select: { providerId: true, providerUserId: true, status: true } } },
    });
    if (!request) return null;
    if (actor.kind === 'customer' && request.ownerId !== actor.userId) return null;
    if (actor.kind === 'provider' && !request.assignments.some((assignment) => assignment.providerUserId === actor.userId && CURRENT_ASSIGNMENTS.has(assignment.status))) return null;
    if (actor.kind === 'staff' && actor.staff?.status !== 'active') return null;
    return request;
  }

  private async currentAssignment(requestId: string) {
    const assignments = await this.prisma.assignment.findMany({
      where: { requestId }, orderBy: { createdAt: 'desc' }, take: 1,
      select: { id: true, providerId: true, providerUserId: true, status: true },
    });
    const current = assignments[0];
    return current && CURRENT_ASSIGNMENTS.has(current.status) ? current : null;
  }
}

export function canReadChannel(actor: ActorContext, ownerId: string, channel: MessageChannelName, providerId: string | null | undefined, current: { providerId: string; providerUserId: string; status: string } | null) {
  if (actor.kind === 'customer') return channel === 'customer' && actor.userId === ownerId;
  if (actor.kind === 'provider') return channel === 'provider' && current?.providerUserId === actor.userId && (!providerId || current.providerId === providerId);
  return actor.kind === 'staff' && actor.staff?.status === 'active' && actor.staff.permissions.has(CHANNEL_PERMISSION[channel]);
}

export function canWriteChannel(actor: ActorContext, ownerId: string, channel: MessageChannelName, providerId: string | null, current: { providerId: string; providerUserId: string; status: string } | null) {
  if (actor.kind === 'customer') return channel === 'customer' && actor.userId === ownerId;
  if (actor.kind === 'provider') return channel === 'provider' && current?.providerUserId === actor.userId && current.providerId === providerId;
  return actor.kind === 'staff' && actor.staff?.status === 'active' && actor.staff.permissions.has(CHANNEL_PERMISSION[channel])
    && (channel !== 'provider' || (current !== null && current.providerId === providerId));
}

export function renderAuthor(role: string, authorId: string | null, viewer: ActorContext, authors: Map<string, string>) {
  if (role === 'staff' && viewer.kind === 'customer') return 'XPro Team';
  if (role === 'staff' && viewer.kind === 'provider') return 'XPro Dispatch';
  if (authorId && authors.has(authorId)) return authors.get(authorId)!;
  if (role === 'staff') return 'XPro';
  return role === 'provider' ? 'Provider' : 'Customer';
}

function forbiddenChannel() {
  return new AppError(403, 'FORBIDDEN', 'Choose a conversation available to your account.');
}

function opaqueNotFound() {
  return new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
}
