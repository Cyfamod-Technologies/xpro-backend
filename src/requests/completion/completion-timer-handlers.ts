import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { FinanceService } from '../../payments/finance.service';
import { RequestCommandRunner } from '../command-runner';

@Injectable()
export class CompletionTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
    private readonly finance: FinanceService,
  ) {
    registry.register('T17.reminder24h', (timer) => this.remind(timer));
    registry.register('T17.reminder48h', (timer) => this.remind(timer));
    registry.register('T17.autoConfirm', (timer) => this.autoConfirm(timer));
    registry.register('T21.defectsEnd', (timer) => this.readyToClose(timer));
  }

  private async remind(timer: RequestTimer) {
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'completion_pending') return { changed: false };
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: { confirmDueAt: true },
        });
        if (!request?.confirmDueAt || request.confirmDueAt <= ctx.now)
          return { changed: false };
        ctx.notify('completion.reminder', { requestCode: ctx.snap.number });
      },
      { bumpVersion: false },
    );
  }

  private async autoConfirm(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T17.autoConfirm',
      timer.requestId,
      async (ctx) => {
        if (
          ctx.snap.status !== 'completion_pending' ||
          ctx.snap.hold ||
          ctx.snap.openIssues.length
        )
          return { changed: false };
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: { confirmDueAt: true, cancellationId: true },
        });
        if (
          !request?.confirmDueAt ||
          request.confirmDueAt > ctx.now ||
          request.cancellationId
        )
          return { changed: false };
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        const quote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        if (
          !assignment ||
          quote?.payoutAmount == null ||
          quote.payoutAssignmentId !== assignment.id
        )
          return { changed: false };
        const days = Number(ctx.settings['completion.defectsWindowDays'] ?? 7);
        const endsAt = new Date(ctx.now.getTime() + days * 86_400_000);
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            status: 'acknowledged',
            acknowledgedAt: ctx.now,
            acknowledgedBy: 'system',
            acknowledgedNote: 'No response within 72 h',
            defectsWindowEndsAt: endsAt,
          },
        });
        await this.finance.createPrimary(ctx, {
          requestId: ctx.snap.id,
          assignmentId: assignment.id,
          providerId: assignment.providerId,
          amount: quote.payoutAmount,
          payoutAssignmentId: quote.payoutAssignmentId,
        });
        ctx.timers.stop([
          'T17.reminder24h',
          'T17.reminder48h',
          'T17.autoConfirm',
        ]);
        ctx.approvals.open('ready_to_close', ctx.snap.id);
        ctx.audit('Completion auto-confirmed', {
          changes: { assignmentId: assignment.id, defectsWindowEndsAt: endsAt },
        });
        ctx.notify('completion.auto_confirmed', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }

  private async readyToClose(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T21.defectsEnd',
      timer.requestId,
      (ctx) => {
        const endsAt = ctx.snap.defectsWindowEndsAt;
        if (ctx.snap.status !== 'acknowledged' || !endsAt || endsAt > ctx.now)
          return Promise.resolve({ changed: false });
        ctx.approvals.open('ready_to_close', ctx.snap.id);
        ctx.audit('Ready to close');
        return Promise.resolve();
      },
      { bumpVersion: false },
    );
  }
}
