import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsHooks } from '../approvals.hooks';
import { TimerRegistry } from '../../platform/timers/timer-registry';

@Injectable()
export class ExecutionTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcher,
    private readonly outbox: OutboxService,
    private readonly approvals: ApprovalsHooks,
  ) {
    registry.register('T15.stale', (timer) => this.stale(timer));
    registry.register('T15.escalate', (timer) => this.escalate(timer));
    registry.register('T16.review', (timer) => this.holdReview(timer));
  }

  private async stale(timer: RequestTimer) {
    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: { id: true, number: true, status: true, ownerId: true },
      });
      if (!request || request.status !== 'in_progress') return false;
      const pending = await tx.progressUpdate.findFirst({
        where: { requestId: request.id, state: 'pending' },
        select: { id: true },
      });
      if (pending) return false;
      await this.approvals.open(
        tx,
        'progress',
        request.id,
        request.id,
        new Date(),
      );
      await this.notifications.dispatch(
        tx,
        'progress.stale',
        { requestCode: format(request.number) },
        { requestId: request.id, ownerId: request.ownerId, actorId: null },
      );
      return true;
    });
    if (created) await this.outbox.kick();
  }

  private async escalate(timer: RequestTimer) {
    await this.prisma.$transaction(async (tx) => {
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: { id: true, status: true },
      });
      if (!request || request.status !== 'in_progress') return;
      const exists = await tx.requestEscalation.findFirst({
        where: {
          requestId: request.id,
          target: 'operations',
          resolvedAt: null,
        },
      });
      if (exists) return;
      const row = await tx.requestEscalation.create({
        data: {
          requestId: request.id,
          target: 'operations',
          source: 'system',
          note: 'No progress update was recorded before the escalation deadline.',
          raisedAt: new Date(),
        },
      });
      await this.approvals.open(
        tx,
        'escalation',
        row.id,
        request.id,
        new Date(),
      );
    });
  }

  private async holdReview(timer: RequestTimer) {
    const sent = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`,
      );
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: {
          id: true,
          number: true,
          status: true,
          holdKind: true,
          ownerId: true,
        },
      });
      if (!request || request.status !== 'blocked') return false;
      await this.approvals.open(
        tx,
        'blocker',
        request.id,
        request.id,
        new Date(),
      );
      await this.notifications.dispatch(
        tx,
        'progress.hold_review',
        { requestCode: format(request.number) },
        { requestId: request.id, ownerId: request.ownerId, actorId: null },
      );
      return true;
    });
    if (sent) await this.outbox.kick();
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
