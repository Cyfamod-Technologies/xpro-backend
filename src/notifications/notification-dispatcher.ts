import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InboxService } from './inbox.service';
import {
  NOTIFICATION_CATALOGUE,
  renderNotification,
  type NotificationEvent,
} from './catalogue';
import { StaffRoutingService } from './staff-routing.service';
import { OutboxService } from '../platform/outbox/outbox.service';

type DispatchDb = Pick<Prisma.TransactionClient, 'inAppNotification' | 'outboxEvent' | 'serviceRequest'>;
type DispatchContext = { requestId: string; ownerId: string; actorId: string | null };
type Recipient = { recipientId: string; requestId: string | null; link: string | null };

const ACCESSIBLE_ASSIGNMENTS = new Set(['offered', 'pending_approval', 'accepted', 'completed']);

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly inbox: InboxService,
    private readonly staffRouting: StaffRoutingService,
    private readonly outbox: OutboxService,
  ) {}

  async dispatch(
    tx: DispatchDb,
    event: string,
    params: Record<string, unknown>,
    context: DispatchContext,
  ): Promise<void> {
    if (!(event in NOTIFICATION_CATALOGUE)) {
      throw new Error(`Unknown notification event: ${event}`);
    }
    const rendered = renderNotification(event as NotificationEvent, params as never);
    const recipients = await this.recipients(tx, rendered.audience, params, context, rendered.link);
    await this.inbox.createMany(tx, recipients.map((recipient) => ({
      recipientId: recipient.recipientId,
      event: rendered.event,
      title: rendered.title,
      message: rendered.message,
      requestId: recipient.requestId,
      link: recipient.link,
      mandatory: rendered.mandatory,
    })));

    if (rendered.mandatory && (rendered.audience.kind === 'customer' || rendered.audience.kind.startsWith('provider:'))) {
      for (const recipient of recipients) {
        await this.outbox.add(tx, 'email.notify', {
          recipientId: recipient.recipientId,
          event: rendered.event,
          title: rendered.title,
          message: rendered.message,
          link: recipient.link,
        });
      }
    }
  }

  private async recipients(
    tx: DispatchDb,
    audience: (typeof NOTIFICATION_CATALOGUE)[NotificationEvent]['audience'],
    params: Record<string, unknown>,
    context: DispatchContext,
    link: string | null,
  ): Promise<Recipient[]> {
    const plain = (recipientId: string | null): Recipient[] => recipientId
      ? [{ recipientId, requestId: context.requestId, link }]
      : [];
    switch (audience.kind) {
      case 'customer': return plain(context.ownerId);
      case 'provider:current': {
        const request = await tx.serviceRequest.findUnique({
          where: { id: context.requestId },
          select: { assignments: { orderBy: { createdAt: 'desc' }, select: { providerUserId: true, status: true } } },
        });
        const assignment = request?.assignments.find((item) => ACCESSIBLE_ASSIGNMENTS.has(item.status));
        const recipient = assignment?.providerUserId ?? null;
        return recipient === context.actorId ? [] : plain(recipient);
      }
      case 'provider:assignment': {
        const assignmentId = params.assignmentId;
        const providerUserId = params.providerUserId;
        const request = await tx.serviceRequest.findUnique({
          where: { id: context.requestId },
          select: { assignments: { orderBy: { createdAt: 'desc' }, select: { id: true, providerUserId: true, status: true } } },
        });
        const assignment = request?.assignments.find((item) =>
          (typeof assignmentId === 'string' && item.id === assignmentId)
          || (typeof assignmentId !== 'string' && typeof providerUserId === 'string' && item.providerUserId === providerUserId),
        );
        if (!assignment) return [];
        const recipientId = assignment.providerUserId !== context.actorId ? assignment.providerUserId : null;
        const accessible = ACCESSIBLE_ASSIGNMENTS.has(assignment.status);
        return recipientId ? [{
          recipientId,
          requestId: accessible ? context.requestId : null,
          link: accessible ? link : null,
        }] : [];
      }
      case 'staff:gated':
        return (await this.staffRouting.audience('gated', {
          requestId: context.requestId,
          ownerId: context.ownerId,
          actorId: context.actorId,
          permission: audience.permission,
        })).map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      case 'staff:holders':
        return (await this.staffRouting.audience('gated_unscoped', {
          requestId: context.requestId,
          ownerId: context.ownerId,
          actorId: context.actorId,
          permission: audience.permission,
        })).map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      case 'staff:info':
        return (await this.staffRouting.audience('informational', {
          requestId: context.requestId,
          ownerId: context.ownerId,
          actorId: context.actorId,
        })).map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      case 'staff:unclaimed': {
        const request = await tx.serviceRequest.findUnique({ where: { id: context.requestId }, select: { staffOwnerId: true } });
        const recipients = request?.staffOwnerId
          ? [request.staffOwnerId].filter((recipientId) => recipientId !== context.actorId)
          : await this.staffRouting.audience('unclaimed', {
              requestId: context.requestId,
              ownerId: context.ownerId,
              actorId: context.actorId,
            });
        return recipients.map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      }
      case 'staff:pricing':
        return (await this.staffRouting.audience('pricing', {
          requestId: context.requestId,
          ownerId: context.ownerId,
          actorId: context.actorId,
        })).map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      case 'staff:recipient': {
        const recipientId = params.recipientId;
        return typeof recipientId === 'string' && recipientId !== context.actorId
          ? [{ recipientId, requestId: context.requestId, link }]
          : [];
      }
      case 'message:participants': {
        const channel = params.channel;
        let ids: string[] = [];
        if (channel === 'customer') {
          const staffRecipients = await this.staffRouting.audience('customer_message', {
            requestId: context.requestId, ownerId: context.ownerId, actorId: context.actorId,
          });
          ids = [context.ownerId, ...staffRecipients];
        } else if (channel === 'provider') {
          const request = await tx.serviceRequest.findUnique({
            where: { id: context.requestId },
            select: { assignments: { orderBy: { createdAt: 'desc' }, take: 1, select: { providerId: true, providerUserId: true, status: true } } },
          });
          const assignment = request?.assignments[0];
          if (assignment && ACCESSIBLE_ASSIGNMENTS.has(assignment.status) && assignment.providerId === params.providerId) {
            ids.push(assignment.providerUserId);
          }
          ids.push(...await this.staffRouting.audience('gated', {
            requestId: context.requestId, ownerId: context.ownerId, actorId: context.actorId, permission: 'message.provider',
          }));
        } else if (channel === 'internal') {
          ids = await this.staffRouting.audience('gated_unscoped', {
            requestId: context.requestId, ownerId: context.ownerId, actorId: context.actorId, permission: 'message.internal',
          });
        }
        return [...new Set(ids)].filter((recipientId) => recipientId !== context.actorId)
          .map((recipientId) => ({ recipientId, requestId: context.requestId, link }));
      }
    }
  }
}
