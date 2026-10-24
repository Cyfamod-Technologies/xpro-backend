import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { TimersService } from '../../platform/timers/timers.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsHooks } from '../approvals.hooks';
import type { NotificationEvent } from '../../notifications/catalogue';

@Injectable()
export class SchedulingTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcher,
    private readonly outbox: OutboxService,
    private readonly timers: TimersService,
    private readonly approvals: ApprovalsHooks,
  ) {
    registry.register('T11.reminder24h', (timer) =>
      this.remind(timer, 'schedule.reminder'),
    );
    registry.register('T11.staff48h', (timer) => this.staffFollowup(timer));
    registry.register('T12.reminder24h', (timer) =>
      this.remind(timer, 'schedule.prestart24h'),
    );
    registry.register('T12.reminder2h', (timer) =>
      this.remind(timer, 'schedule.prestart2h'),
    );
    registry.register('T13.noShowCheck', (timer) =>
      this.checkAttendance(timer),
    );
  }

  private async remind(timer: RequestTimer, event: NotificationEvent) {
    const schedule = await this.prisma.schedule.findFirst({
      where: {
        id: timer.refId,
        requestId: timer.requestId,
        status: { in: ['proposed', 'confirmed'] },
      },
      include: {
        request: { select: { id: true, number: true, ownerId: true } },
      },
    });
    if (!schedule) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        event,
        { requestCode: format(schedule.request.number) },
        {
          requestId: schedule.request.id,
          ownerId: schedule.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async staffFollowup(timer: RequestTimer) {
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.schedule.findFirst({
        where: {
          id: timer.refId,
          requestId: timer.requestId,
          status: 'proposed',
        },
        include: { request: { select: { id: true, number: true } } },
      });
      if (!row) return false;
      await this.approvals.open(
        tx,
        'schedule_change',
        row.id,
        row.requestId,
        new Date(),
      );
      await (this.notifications as any).dispatch(
        tx,
        'schedule.staff_followup',
        { requestCode: format(row.request.number) },
        { requestId: row.request.id, ownerId: null, actorId: null },
      );
      return true;
    });
    if (created) await this.outbox.kick();
  }

  private async checkAttendance(timer: RequestTimer) {
    const result = await this.prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findFirst({
        where: {
          id: timer.refId,
          requestId: timer.requestId,
          status: 'confirmed',
        },
        include: {
          request: {
            select: { id: true, number: true, ownerId: true, status: true },
          },
        },
      });
      if (!schedule || schedule.request.status !== 'scheduled') return false;
      const start = await tx.progressUpdate.findFirst({
        where: {
          requestId: schedule.requestId,
          assignmentId: schedule.assignmentId,
          kind: 'start',
          state: 'approved',
        },
        select: { id: true },
      });
      if (start) return false;
      const pending = await tx.progressUpdate.findFirst({
        where: {
          requestId: schedule.requestId,
          assignmentId: schedule.assignmentId,
          kind: 'start',
          state: 'pending',
        },
        select: { id: true },
      });
      if (pending) {
        await this.timers.start(tx, {
          requestId: schedule.requestId,
          kind: 'T13.noShowCheck',
          dueAt: new Date(timer.dueAt.getTime() + 60 * 60_000),
          refId: schedule.id,
        });
        return false;
      }
      await this.approvals.open(
        tx,
        'no_show',
        schedule.id,
        schedule.requestId,
        new Date(),
      );
      await this.notifications.dispatch(
        tx,
        'noshow.investigate',
        { requestCode: format(schedule.request.number) },
        {
          requestId: schedule.request.id,
          ownerId: schedule.request.ownerId,
          actorId: null,
        },
      );
      return true;
    });
    if (result) await this.outbox.kick();
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
