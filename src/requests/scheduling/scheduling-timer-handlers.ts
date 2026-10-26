import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { RequestCommandRunner } from '../command-runner';
import type { NotificationEvent } from '../../notifications/catalogue';

@Injectable()
export class SchedulingTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
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
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        const schedule = await ctx.tx.schedule.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: { in: ['proposed', 'confirmed'] },
          },
          select: { id: true },
        });
        if (!schedule) return { changed: false };
        ctx.notify(event, { requestCode: ctx.snap.number });
      },
      { bumpVersion: false },
    );
  }

  private async staffFollowup(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T11.staff48h',
      timer.requestId,
      async (ctx) => {
        const schedule = await ctx.tx.schedule.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'proposed',
          },
          select: { id: true },
        });
        if (!schedule) return { changed: false };
        ctx.approvals.open('schedule_change', schedule.id);
        ctx.audit('Schedule follow-up opened', {
          resourceType: 'schedule',
          resourceId: schedule.id,
        });
        ctx.notify('schedule.staff_followup', {
          requestCode: ctx.snap.number,
        });
      },
      { bumpVersion: false },
    );
  }

  private async checkAttendance(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T13.noShowCheck',
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'scheduled') return { changed: false };
        const schedule = await ctx.tx.schedule.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'confirmed',
          },
        });
        if (!schedule) return { changed: false };
        const start = await ctx.tx.progressUpdate.findFirst({
          where: {
            requestId: schedule.requestId,
            assignmentId: schedule.assignmentId,
            kind: 'start',
            state: 'approved',
          },
          select: { id: true },
        });
        if (start) return { changed: false };
        const pending = await ctx.tx.progressUpdate.findFirst({
          where: {
            requestId: schedule.requestId,
            assignmentId: schedule.assignmentId,
            kind: 'start',
            state: 'pending',
          },
          select: { id: true },
        });
        if (pending) {
          ctx.timers.start(
            'T13.noShowCheck',
            new Date(timer.dueAt.getTime() + 60 * 60_000),
            schedule.id,
          );
          return { bumpVersion: false };
        }
        ctx.approvals.open('no_show', schedule.id);
        ctx.audit('No-show check opened', {
          resourceType: 'schedule',
          resourceId: schedule.id,
        });
        ctx.notify('noshow.investigate', { requestCode: ctx.snap.number });
      },
      { bumpVersion: false },
    );
  }
}
