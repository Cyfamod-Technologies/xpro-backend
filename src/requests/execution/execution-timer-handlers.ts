import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { RequestCommandRunner } from '../command-runner';

@Injectable()
export class ExecutionTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
  ) {
    registry.register('T15.stale', (timer) => this.stale(timer));
    registry.register('T15.escalate', (timer) => this.escalate(timer));
    registry.register('T16.review', (timer) => this.holdReview(timer));
  }

  private async stale(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T15.stale',
      timer.requestId,
      (ctx) => {
        if (ctx.snap.status !== 'in_progress' || ctx.snap.pendingUpdates.length)
          return Promise.resolve({ changed: false });
        ctx.approvals.open('progress', ctx.snap.id);
        ctx.audit('Progress update overdue');
        ctx.notify('progress.stale', { requestCode: ctx.snap.number });
        return Promise.resolve();
      },
      { bumpVersion: false },
    );
  }

  private async escalate(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T15.escalate',
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'in_progress') return { changed: false };
        const exists = await ctx.tx.requestEscalation.findFirst({
          where: {
            requestId: ctx.snap.id,
            target: 'operations',
            resolvedAt: null,
          },
          select: { id: true },
        });
        if (exists) return { changed: false };
        const row = await ctx.tx.requestEscalation.create({
          data: {
            requestId: ctx.snap.id,
            target: 'operations',
            source: 'system',
            note: 'No progress update was recorded before the escalation deadline.',
            raisedAt: ctx.now,
          },
        });
        ctx.approvals.open('escalation', row.id);
        ctx.audit('Escalated to operations (no progress update)', {
          resourceType: 'request_escalation',
          resourceId: row.id,
        });
      },
    );
  }

  private async holdReview(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T16.review',
      timer.requestId,
      (ctx) => {
        if (ctx.snap.status !== 'blocked')
          return Promise.resolve({ changed: false });
        ctx.approvals.open('blocker', ctx.snap.id);
        ctx.audit('Hold review due');
        ctx.notify('progress.hold_review', { requestCode: ctx.snap.number });
        return Promise.resolve();
      },
      { bumpVersion: false },
    );
  }
}
