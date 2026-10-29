import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { RequestCommandRunner } from '../command-runner';

@Injectable()
export class PricingTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
  ) {
    registry.register('T7.reminder24h', (timer) =>
      this.costingNotice(timer, 'quote.costing_reminder'),
    );
    registry.register('T7.stall48h', (timer) =>
      this.costingNotice(timer, 'quote.stalled'),
    );
    registry.register('T8.reminder3d', (timer) => this.quoteReminder(timer));
    registry.register('T8.reminder1d', (timer) => this.quoteReminder(timer));
    registry.register('T8.expire', (timer) => this.quoteExpired(timer));
  }

  private async costingNotice(
    timer: RequestTimer,
    event: 'quote.costing_reminder' | 'quote.stalled',
  ) {
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        if (!['matched', 'quoted'].includes(ctx.snap.status))
          return { changed: false };
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'accepted',
          },
          select: { id: true },
        });
        if (!assignment) return { changed: false };
        const contribution = await ctx.tx.contribution.findFirst({
          where: { requestId: ctx.snap.id, assignmentId: assignment.id },
          select: { id: true },
        });
        if (contribution) return { changed: false };
        ctx.notify(event, { requestCode: ctx.snap.number });
      },
      { bumpVersion: false },
    );
  }

  private async quoteReminder(timer: RequestTimer) {
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'sent',
          },
        });
        if (!quote?.validUntil || quote.validUntil <= ctx.now)
          return { changed: false };
        ctx.notify('quote.payment_reminder', {
          requestCode: ctx.snap.number,
          dueDate: quote.validUntil.toLocaleDateString('en-NG', {
            timeZone: 'Africa/Lagos',
          }),
        });
      },
      { bumpVersion: false },
    );
  }

  private async quoteExpired(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T8.expire',
      timer.requestId,
      async (ctx) => {
        if (!['quoted', 'awaiting_payment'].includes(ctx.snap.status))
          return { changed: false };
        const quote = await ctx.tx.quote.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'sent',
          },
        });
        if (!quote?.validUntil || quote.validUntil > ctx.now)
          return { changed: false };
        await ctx.tx.quote.update({
          where: { id: quote.id },
          data: { status: 'expired' },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: quote.requestId },
          data: { status: 'matched' },
        });
        ctx.audit('Quote expired', {
          resourceType: 'quote',
          resourceId: quote.id,
          changes: { quoteId: quote.id, version: quote.version },
        });
        ctx.notify('quote.expired', {
          requestCode: ctx.snap.number,
          version: quote.version,
        });
        ctx.approvals.open('quote_expired', quote.id);
      },
    );
  }
}
