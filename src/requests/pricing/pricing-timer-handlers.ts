import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PricingTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcher,
    private readonly outbox: OutboxService,
  ) {
    registry.register('T7.reminder24h', (timer) => this.costingReminder(timer));
    registry.register('T7.stall48h', (timer) => this.costingStalled(timer));
    registry.register('T8.reminder3d', (timer) => this.quoteReminder(timer));
    registry.register('T8.reminder1d', (timer) => this.quoteReminder(timer));
    registry.register('T8.expire', (timer) => this.quoteExpired(timer));
  }

  private async costingReminder(timer: RequestTimer) {
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        id: timer.refId,
        requestId: timer.requestId,
        status: 'accepted',
      },
      include: {
        request: {
          select: { id: true, number: true, ownerId: true, status: true },
        },
      },
    });
    if (
      !assignment ||
      !['matched', 'quoted'].includes(assignment.request.status)
    )
      return;
    const contribution = await this.prisma.contribution.findFirst({
      where: { requestId: timer.requestId, assignmentId: assignment.id },
    });
    if (contribution) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        'quote.costing_reminder',
        { requestCode: format(assignment.request.number) },
        {
          requestId: assignment.request.id,
          ownerId: assignment.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async costingStalled(timer: RequestTimer) {
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        id: timer.refId,
        requestId: timer.requestId,
        status: 'accepted',
      },
      include: {
        request: {
          select: { id: true, number: true, ownerId: true, status: true },
        },
      },
    });
    if (
      !assignment ||
      !['matched', 'quoted'].includes(assignment.request.status)
    )
      return;
    const contribution = await this.prisma.contribution.findFirst({
      where: { requestId: timer.requestId, assignmentId: assignment.id },
    });
    if (contribution) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        'quote.stalled',
        { requestCode: format(assignment.request.number) },
        {
          requestId: assignment.request.id,
          ownerId: assignment.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async quoteReminder(timer: RequestTimer) {
    const quote = await this.prisma.quote.findFirst({
      where: { id: timer.refId, requestId: timer.requestId, status: 'sent' },
      include: {
        request: { select: { id: true, number: true, ownerId: true } },
      },
    });
    if (!quote?.validUntil || quote.validUntil <= new Date()) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        'quote.payment_reminder',
        {
          requestCode: format(quote.request.number),
          dueDate: quote.validUntil!.toLocaleDateString('en-NG', {
            timeZone: 'Africa/Lagos',
          }),
        },
        {
          requestId: quote.request.id,
          ownerId: quote.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async quoteExpired(timer: RequestTimer) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`,
      );
      const quote = await tx.quote.findFirst({
        where: { id: timer.refId, requestId: timer.requestId, status: 'sent' },
        include: {
          request: {
            select: { id: true, number: true, ownerId: true, status: true },
          },
        },
      });
      if (
        !quote?.validUntil ||
        quote.validUntil > new Date() ||
        !['quoted', 'awaiting_payment'].includes(quote.request.status)
      )
        return null;
      await tx.quote.update({
        where: { id: quote.id },
        data: { status: 'expired' },
      });
      await tx.serviceRequest.update({
        where: { id: quote.requestId },
        data: {
          status: 'matched',
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          entityType: 'service_request',
          entityId: quote.requestId,
          action: 'Quote expired',
          metadata: { quoteId: quote.id },
        },
      });
      await this.notifications.dispatch(
        tx,
        'quote.expired',
        { requestCode: format(quote.request.number) },
        {
          requestId: quote.request.id,
          ownerId: quote.request.ownerId,
          actorId: null,
        },
      );
      return true;
    });
    if (result) await this.outbox.kick();
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
