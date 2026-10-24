import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OutboxService } from '../platform/outbox/outbox.service';
import { TimersService } from '../platform/timers/timers.service';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class T6TimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcher,
    private readonly timers: TimersService,
    private readonly outbox: OutboxService,
  ) {
    registry.register(TimerKinds.T6Reminder48h, (timer) =>
      this.notifyIfCurrent(timer, 'request.clarification_reminder'),
    );
    registry.register(TimerKinds.T6Staff5d, (timer) =>
      this.notifyIfCurrent(timer, 'request.clarification_overdue'),
    );
    registry.register(TimerKinds.T6FinalWarning, (timer) =>
      this.notifyIfCurrent(timer, 'request.clarification_final_warning'),
    );
    registry.register(TimerKinds.T6AutoCancel, (timer) =>
      this.autoCancel(timer),
    );
  }

  private async notifyIfCurrent(
    timer: RequestTimer,
    event:
      | 'request.clarification_reminder'
      | 'request.clarification_overdue'
      | 'request.clarification_final_warning',
  ) {
    const sent = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE
      `;
      if (!locked.length) return false;
      const current = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: {
          id: true,
          number: true,
          ownerId: true,
          status: true,
          intakeState: true,
          clarificationAskedAt: true,
        },
      });
      if (!isAwaitingResponse(current, timer)) return false;
      await this.notifications.dispatch(
        tx,
        event,
        { requestCode: formatNumber(current.number) },
        {
          requestId: current.id,
          ownerId: current.ownerId,
          actorId: null,
        },
      );
      return true;
    });
    if (sent) await this.outbox.kick();
  }

  private async autoCancel(timer: RequestTimer) {
    const payload = timer.payload;
    const expectedAt =
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload['clarificationAskedAt'] === 'string'
        ? payload['clarificationAskedAt']
        : null;
    if (!expectedAt) return;

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE
      `;
      if (!locked.length) return false;
      const row = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
        select: {
          id: true,
          number: true,
          ownerId: true,
          status: true,
          intakeState: true,
          clarificationAskedAt: true,
        },
      });
      if (
        !isAwaitingResponse(row, timer) ||
        row?.clarificationAskedAt?.toISOString() !== expectedAt
      )
        return false;
      const now = new Date();
      const cancellation = await tx.cancellation.create({
        data: {
          requestId: row.id,
          requestedBy: 'system',
          reasonCode: 'no_response',
          status: 'completed',
          note: 'No response to the clarification request within 14 days.',
          stage: 'submitted',
          decidedAt: now,
          decisionNote:
            'Automatically cancelled after 14 days without a customer response.',
        },
      });
      await tx.serviceRequest.update({
        where: { id: row.id },
        data: {
          status: 'cancelled',
          cancellationId: cancellation.id,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await tx.requestMessage.create({
        data: {
          requestId: row.id,
          channel: 'customer',
          authorRole: 'system',
          text: "Cancelled: we didn't hear back from you.",
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          actorId: null,
          entityType: 'service_request',
          entityId: row.id,
          action: 'Request cancelled (no response)',
          metadata: {
            requestId: row.id,
            reasonCode: 'no_response',
            timerId: timer.id,
          },
        },
      });
      await this.notifications.dispatch(
        tx,
        'request.auto_cancelled',
        { requestCode: formatNumber(row.number) },
        {
          requestId: row.id,
          ownerId: row.ownerId,
          actorId: null,
        },
      );
      await this.timers.stop(tx, {
        requestId: row.id,
        kinds: [
          TimerKinds.T6Reminder48h,
          TimerKinds.T6Staff5d,
          TimerKinds.T6FinalWarning,
          TimerKinds.T6AutoCancel,
        ],
      });
      return true;
    });
    if (cancelled) await this.outbox.kick();
  }
}

type IntakeTimerRequest = {
  id: string;
  number: number;
  ownerId: string;
  status: string;
  intakeState: string;
  clarificationAskedAt: Date | null;
} | null;

function isAwaitingResponse(
  request: IntakeTimerRequest,
  timer: RequestTimer,
): request is NonNullable<IntakeTimerRequest> {
  if (
    !request ||
    request.status !== 'submitted' ||
    request.intakeState !== 'clarification' ||
    !request.clarificationAskedAt
  )
    return false;
  const payload = timer.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  const askedAt = payload['clarificationAskedAt'];
  return (
    typeof askedAt === 'string' &&
    request.clarificationAskedAt.toISOString() === askedAt
  );
}

function formatNumber(number: number): string {
  return `XPR-${String(number).padStart(5, '0')}`;
}
