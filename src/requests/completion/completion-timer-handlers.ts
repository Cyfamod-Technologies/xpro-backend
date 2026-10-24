import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { PrismaService } from '../../prisma/prisma.service';
import { FinanceService } from '../../payments/finance.service';
import { ApprovalsHooks } from '../approvals.hooks';

@Injectable()
export class CompletionTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcher,
    private readonly outbox: OutboxService,
    private readonly finance: FinanceService,
    private readonly approvals: ApprovalsHooks,
  ) {
    registry.register('T17.reminder24h', (timer) => this.remind(timer));
    registry.register('T17.reminder48h', (timer) => this.remind(timer));
    registry.register('T17.autoConfirm', (timer) => this.autoConfirm(timer));
    registry.register('T21.defectsEnd', (timer) => this.readyToClose(timer));
  }

  private async remind(timer: RequestTimer) {
    const sent = await this.prisma.$transaction(async (tx) => {
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: {
          id: true,
          number: true,
          ownerId: true,
          status: true,
          confirmDueAt: true,
        },
      });
      if (
        !request ||
        request.status !== 'completion_pending' ||
        !request.confirmDueAt ||
        request.confirmDueAt <= new Date()
      )
        return false;
      await this.notifications.dispatch(
        tx,
        'completion.reminder',
        { requestCode: format(request.number) },
        { requestId: request.id, ownerId: request.ownerId, actorId: null },
      );
      return true;
    });
    if (sent) await this.outbox.kick();
  }

  private async autoConfirm(timer: RequestTimer) {
    const now = new Date();
    const confirmed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`,
      );
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: {
          id: true,
          number: true,
          ownerId: true,
          status: true,
          confirmDueAt: true,
          holdKind: true,
          cancellationId: true,
        },
      });
      if (
        !request ||
        request.status !== 'completion_pending' ||
        !request.confirmDueAt ||
        request.confirmDueAt > now ||
        request.holdKind ||
        request.cancellationId
      )
        return false;
      const openIssue = await tx.issue.findFirst({
        where: {
          requestId: request.id,
          status: { in: ['open', 'rework', 'disputed'] },
        },
        select: { id: true },
      });
      if (openIssue) return false;
      const assignment = await tx.assignment.findFirst({
        where: { requestId: request.id, status: 'accepted' },
        orderBy: { createdAt: 'desc' },
      });
      const quote = await tx.quote.findFirst({
        where: { requestId: request.id, status: 'accepted' },
        orderBy: { version: 'desc' },
      });
      if (
        !assignment ||
        quote?.payoutAmount == null ||
        quote.payoutAssignmentId !== assignment.id
      )
        return false;
      const days = Number(
        (
          await tx.setting.findUnique({
            where: { key: 'completion.defectsWindowDays' },
            select: { value: true },
          })
        )?.value ?? 7,
      );
      const endsAt = new Date(now.getTime() + days * 86_400_000);
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: {
          status: 'acknowledged',
          acknowledgedAt: now,
          acknowledgedBy: 'system',
          acknowledgedNote: 'No response within 72 h',
          defectsWindowEndsAt: endsAt,
          version: { increment: 1 },
        },
      });
      await this.finance.createPrimary(tx, {
        requestId: request.id,
        assignmentId: assignment.id,
        providerId: assignment.providerId,
        amount: quote.payoutAmount,
        now,
      });
      await tx.requestTimer.updateMany({
        where: {
          requestId: request.id,
          kind: { startsWith: 'T17.' },
          status: 'pending',
        },
        data: { status: 'cancelled' },
      });
      await this.approvals.open(
        tx,
        'ready_to_close',
        request.id,
        request.id,
        now,
      );
      await this.notifications.dispatch(
        tx,
        'completion.auto_confirmed',
        { requestCode: format(request.number) },
        { requestId: request.id, ownerId: request.ownerId, actorId: null },
      );
      return true;
    });
    if (confirmed) await this.outbox.kick();
  }

  private async readyToClose(timer: RequestTimer) {
    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: { id: true, status: true, defectsWindowEndsAt: true },
      });
      if (
        !request ||
        request.status !== 'acknowledged' ||
        !request.defectsWindowEndsAt ||
        request.defectsWindowEndsAt > new Date()
      )
        return false;
      await this.approvals.open(
        tx,
        'ready_to_close',
        request.id,
        request.id,
        new Date(),
      );
      return true;
    });
    void created;
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
