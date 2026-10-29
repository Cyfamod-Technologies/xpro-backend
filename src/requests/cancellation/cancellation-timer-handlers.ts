import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import { RequestCommandRunner } from '../command-runner';

@Injectable()
export class CancellationTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
  ) {
    registry.register(TimerKinds.T19Followup, (timer) => this.followUp(timer));
  }

  /**
   * T19 (04 §8): 48 hours after a cancellation request, staff are reminded
   * through the `cancellation` approval item. Nothing is approved or cancelled
   * automatically. A decided or withdrawn cancellation makes the timer a no-op.
   */
  private async followUp(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T19.followup',
      timer.requestId,
      (ctx) => {
        const pending = ctx.snap.pendingCancellationInfo;
        if (!pending || pending.id !== timer.refId)
          return Promise.resolve({ changed: false });
        ctx.approvals.open('cancellation', pending.id);
        ctx.audit('Cancellation follow-up', {
          resourceType: 'cancellation',
          resourceId: pending.id,
        });
        ctx.notify('cancellation.followup', { requestCode: ctx.snap.number });
        return Promise.resolve({ bumpVersion: false });
      },
      { bumpVersion: false },
    );
  }
}
