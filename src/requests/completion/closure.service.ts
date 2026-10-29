import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requirePermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import type { RequestUser } from '../../common/types/request-user';
import { FinanceService } from '../../payments/finance.service';
import { closeEndedRequestApprovals } from '../approval-effects';
import { RequestCommandRunner } from '../command-runner';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
// new message: not in spec (04 §6.17 says only that financial guard errors come from 05)
const PAYOUT_BLOCKS_CLOSURE =
  'A provider payout must be paid or held with a reason before closure.';

@Injectable()
export class ClosureService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly finance: FinanceService,
  ) {}

  async close(
    user: RequestUser,
    requestId: string,
    dto: { note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.close');
    return this.runner.run(
      {
        command: 'request.close',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        input: dto,
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, dto),
            }
          : {}),
      },
      async (ctx) => {
        // 04 §5.2 #36 payout rule: payout rows are not in the snapshot. Only the primary payout counts (C-18).
        const payout = await this.finance.closureState(ctx.tx, ctx.snap.id);
        if (payout.state === 'blocked')
          throw conflict(payout.reason ?? PAYOUT_BLOCKS_CLOSURE);
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'closed', closedAt: ctx.now, closedBy: user.id },
        });
        await ctx.tx.assignment.updateMany({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          data: { status: 'completed' },
        });
        ctx.timers.stop(Object.values(TimerKinds));
        // Closing keeps only the money items Finance still has to decide (02 §6.11, plan C.5).
        await closeEndedRequestApprovals(ctx, 'request_closed');
        ctx.audit('Job closed', { note: dto.note });
        ctx.notify('request.closed', { requestCode: ctx.snap.number });
      },
    );
  }
}
