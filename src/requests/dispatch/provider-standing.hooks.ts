import { Injectable } from '@nestjs/common';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { TimersService } from '../../platform/timers/timers.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProviderStandingHooks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timers: TimersService,
    private readonly notifications: NotificationDispatcher,
    private readonly outbox: OutboxService,
  ) {}

  async onProviderUnavailable(providerId: string, reason: string) {
    const affected = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.providerProfile.findUnique({
        where: { id: providerId },
        select: { id: true, userId: true },
      });
      if (!profile) return [];
      const offers = await tx.assignment.findMany({
        where: { providerId, status: { in: ['offered', 'pending_approval'] } },
        include: {
          request: {
            select: {
              id: true,
              number: true,
              ownerId: true,
              dispatchMode: true,
              autoAttempts: true,
            },
          },
        },
      });
      const requestIds = new Set<string>();
      for (const assignment of offers) {
        await tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'withdrawn',
            endReason: 'provider_suspended',
            endedAt: new Date(),
            response: reason,
          },
        });
        await this.timers.stop(tx, {
          requestId: assignment.requestId,
          kinds: ['T1.reminder', 'T1.expire', 'T3.review'],
          refId: assignment.id,
        });
        requestIds.add(assignment.requestId);
        const hasOther = await tx.assignment.findFirst({
          where: {
            requestId: assignment.requestId,
            id: { not: assignment.id },
            status: { in: ['offered', 'pending_approval', 'accepted'] },
          },
          select: { id: true },
        });
        if (hasOther) continue;
        const auto = assignment.request.dispatchMode === 'auto';
        await tx.serviceRequest.update({
          where: { id: assignment.requestId },
          data: {
            status: 'under_review',
            needsAssignmentReason: auto ? null : 'provider_suspended',
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        if (auto)
          await this.timers.start(tx, {
            requestId: assignment.requestId,
            kind: 'dispatch.cascade',
            dueAt: new Date(),
            payload: { trigger: 'provider_standing_changed' },
          });
        else
          await this.notifications.dispatch(
            tx,
            'request.needs_manual_assignment',
            { requestCode: format(assignment.request.number) },
            {
              requestId: assignment.request.id,
              ownerId: assignment.request.ownerId,
              actorId: null,
            },
          );
      }
      const accepted = await tx.assignment.findMany({
        where: { providerId, status: 'accepted' },
        include: {
          request: { select: { id: true, number: true, ownerId: true } },
        },
      });
      for (const assignment of accepted) {
        await tx.payout.updateMany({
          where: {
            assignmentId: assignment.id,
            status: {
              in: ['pending_approval', 'awaiting_second_approval', 'approved'],
            },
          },
          data: {
            status: 'on_hold',
            holdReason: reason,
            holdSource: 'provider_standing',
          },
        });
        await this.notifications.dispatch(
          tx,
          'request.provider_standing_changed',
          { requestCode: format(assignment.request.number), reason },
          {
            requestId: assignment.request.id,
            ownerId: assignment.request.ownerId,
            actorId: null,
          },
        );
        requestIds.add(assignment.requestId);
      }
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          entityType: 'provider_profile',
          entityId: providerId,
          action: 'Provider standing changed',
          metadata: { reason, affectedRequestIds: [...requestIds] },
        },
      });
      return [...requestIds];
    });
    if (affected.length) {
      await this.timers.kick();
      await this.outbox.kick();
    }
  }

  async onCustomerSuspended(userId: string) {
    const requests = await this.prisma.serviceRequest.findMany({
      where: {
        ownerId: userId,
        status: { notIn: ['closed', 'cancelled', 'rejected'] },
      },
      select: { id: true, number: true, ownerId: true },
    });
    for (const request of requests) {
      await this.prisma.$transaction((tx) =>
        this.notifications.dispatch(
          tx,
          'request.customer_suspended',
          { requestCode: format(request.number) },
          { requestId: request.id, ownerId: request.ownerId, actorId: null },
        ),
      );
    }
    if (requests.length) await this.outbox.kick();
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
