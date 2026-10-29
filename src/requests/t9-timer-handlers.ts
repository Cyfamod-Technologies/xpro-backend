import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../platform/timers/timer-registry';
import {
  PENDING_ATTEMPT_WINDOW_MS,
  isFreshPendingAttempt,
  newestPendingAttempt,
} from '../payments/domain/pending-attempt';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestCommandRunner } from './command-runner';

@Injectable()
export class T9TimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly runner: RequestCommandRunner,
    private readonly payments: PaymentsService,
  ) {
    registry.register('T9.reminder24h', (timer) => this.remind(timer));
    registry.register('T9.reminder72h', (timer) => this.remind(timer));
    registry.register('T9.lapse', (timer) => this.lapse(timer));
    registry.register('payment.pendingCheck', (timer) =>
      this.pendingCheck(timer),
    );
  }

  /** 05 §8: 30 minutes after checkout starts, ask Paystack what became of the attempt. */
  private async pendingCheck(timer: RequestTimer) {
    const result = await this.payments.recheckPending(timer.refId);
    if (result !== 'pending') return;
    await this.runner.runSystem(
      'timer.payment.pendingCheck',
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'awaiting_payment') return { changed: false };
        const attempt = await ctx.tx.payment.findFirst({
          where: { id: timer.refId, status: 'pending' },
          select: { id: true },
        });
        if (!attempt) return { changed: false };
        ctx.timers.start(
          'payment.pendingCheck',
          new Date(ctx.now.getTime() + PENDING_ATTEMPT_WINDOW_MS),
          attempt.id,
        );
        return { bumpVersion: false };
      },
      { bumpVersion: false },
    );
  }

  private async remind(timer: RequestTimer) {
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'awaiting_payment') return { changed: false };
        const quote = await ctx.tx.quote.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'accepted',
          },
        });
        if (!quote?.paymentDueAt || quote.paymentDueAt <= ctx.now)
          return { changed: false };
        ctx.notify('payment.reminder', {
          requestCode: ctx.snap.number,
          amount: Number(quote.total),
          dueDate: quote.paymentDueAt.toLocaleDateString('en-NG', {
            timeZone: 'Africa/Lagos',
          }),
        });
      },
      { bumpVersion: false },
    );
  }

  private async lapse(timer: RequestTimer) {
    const pending = await this.prisma.payment.findFirst({
      where: {
        requestId: timer.requestId,
        quoteId: timer.refId,
        status: 'pending',
        method: 'paystack',
      },
      select: { id: true },
    });
    if (
      pending &&
      (await this.payments.recheckPending(pending.id)) === 'settled'
    )
      return;
    await this.runner.runSystem(
      'timer.T9.lapse',
      timer.requestId,
      async (ctx) => {
        if (ctx.snap.status !== 'awaiting_payment') return { changed: false };
        const quote = await ctx.tx.quote.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'accepted',
          },
        });
        if (!quote?.paymentDueAt || quote.paymentDueAt > ctx.now)
          return { changed: false };
        // 04 §6.12: a pending attempt younger than 30 minutes defers the lapse; an older one does not.
        const attempts = await ctx.tx.payment.findMany({
          where: {
            requestId: quote.requestId,
            quoteId: quote.id,
            status: 'pending',
            method: 'paystack',
          },
          select: { status: true, method: true, createdAt: true },
        });
        if (isFreshPendingAttempt(newestPendingAttempt(attempts), ctx.now)) {
          ctx.timers.start(
            'T9.lapse',
            new Date(ctx.now.getTime() + PENDING_ATTEMPT_WINDOW_MS),
            quote.id,
          );
          return { bumpVersion: false };
        }
        await ctx.tx.quote.update({
          where: { id: quote.id },
          data: { status: 'expired' },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: quote.requestId },
          data: { status: 'matched' },
        });
        ctx.audit('Payment window lapsed', { changes: { quoteId: quote.id } });
        ctx.approvals.open('payment_lapsed', quote.id);
        ctx.notify('payment.lapsed', { requestCode: ctx.snap.number });
      },
    );
  }
}
