import { Injectable } from '@nestjs/common';
import type { Prisma, RequestTimer } from '@prisma/client';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { RequestCommandRunner } from './command-runner';
import { clarificationAutoCancelDays } from './domain/clarification-timers';
import type { RequestSnapshot } from './domain/snapshot';

const T6_TIMERS = [
  TimerKinds.T6Reminder48h,
  TimerKinds.T6Staff5d,
  TimerKinds.T6FinalWarning,
  TimerKinds.T6AutoCancel,
];

@Injectable()
export class T6TimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
  ) {
    registry.register(TimerKinds.T6Reminder48h, (timer) =>
      this.notifyIfCurrent(timer, 'request.clarification_reminder'),
    );
    registry.register(TimerKinds.T6Staff5d, (timer) =>
      this.notifyIfCurrent(timer, 'request.clarification_overdue', true),
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
    opensStaffItem = false,
  ) {
    await this.runner.runSystem(
      `timer.${timer.kind}`,
      timer.requestId,
      async (ctx) => {
        const askedAt = await clarificationAskedAt(ctx.tx, ctx.snap.id);
        if (!isAwaitingResponse(ctx.snap, askedAt, timer))
          return { changed: false };
        ctx.notify(event, { requestCode: ctx.snap.number });
        // 04 §6.4: the staff item appears at the escalation point (day 5 by default), not when the question is asked.
        if (opensStaffItem)
          ctx.approvals.open('clarification_overdue', ctx.snap.id);
      },
      { bumpVersion: false },
    );
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

    await this.runner.runSystem(
      'timer.T6.autoCancel',
      timer.requestId,
      async (ctx) => {
        const askedAt = await clarificationAskedAt(ctx.tx, ctx.snap.id);
        if (
          !isAwaitingResponse(ctx.snap, askedAt, timer) ||
          askedAt?.toISOString() !== expectedAt
        )
          return { changed: false };
        const days = clarificationAutoCancelDays(ctx.settings);
        const cancellation = await ctx.tx.cancellation.create({
          data: {
            requestId: ctx.snap.id,
            requestedBy: 'system',
            reasonCode: 'no_response',
            status: 'completed',
            note: `No response to the clarification request within ${days} days.`,
            stage: 'submitted',
            decidedAt: ctx.now,
            decisionNote: `Automatically cancelled after ${days} days without a customer response.`,
          },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'cancelled', cancellationId: cancellation.id },
        });
        await ctx.tx.requestMessage.create({
          data: {
            requestId: ctx.snap.id,
            channel: 'customer',
            authorRole: 'system',
            text: "Cancelled: we didn't hear back from you.",
          },
        });
        ctx.audit('Request cancelled (no response)', {
          changes: { reasonCode: 'no_response', timerId: timer.id },
        });
        ctx.notify('request.auto_cancelled', { requestCode: ctx.snap.number });
        ctx.timers.stop(T6_TIMERS);
        ctx.approvals.close('intake', ctx.snap.id, 'cancelled');
        ctx.approvals.close('clarification_overdue', ctx.snap.id, 'cancelled');
        ctx.approvals.close('unclaimed', ctx.snap.id, 'cancelled');
      },
    );
  }
}

async function clarificationAskedAt(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<Date | null> {
  const row = await tx.serviceRequest.findUnique({
    where: { id: requestId },
    select: { clarificationAskedAt: true },
  });
  return row?.clarificationAskedAt ?? null;
}

function isAwaitingResponse(
  snap: Pick<RequestSnapshot, 'status' | 'intake'>,
  askedAt: Date | null,
  timer: RequestTimer,
): askedAt is Date {
  if (
    snap.status !== 'submitted' ||
    snap.intake.state !== 'clarification' ||
    !askedAt
  )
    return false;
  const payload = timer.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  const payloadAskedAt = payload['clarificationAskedAt'];
  return (
    typeof payloadAskedAt === 'string' &&
    askedAt.toISOString() === payloadAskedAt
  );
}
