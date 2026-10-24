import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requirePermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class ClosureService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async close(
    user: RequestUser,
    requestId: string,
    dto: { note?: string },
    version: number,
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
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, dto),
            }
          : {}),
      },
      async (ctx) => {
        if (ctx.snap.status !== 'acknowledged' || ctx.snap.openIssues.length)
          throw conflict(
            'Customer acknowledgement is required before final closure.',
          );
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: { defectsWindowEndsAt: true },
        });
        if (
          request?.defectsWindowEndsAt &&
          request.defectsWindowEndsAt > ctx.now &&
          !dto.note?.trim()
        )
          throw conflict(
            'Add a reason to close this request before the defects window ends.',
          );
        const payouts = await ctx.tx.payout.findMany({
          where: { requestId: ctx.snap.id },
          orderBy: { createdAt: 'desc' },
        });
        const payoutReady =
          payouts.length > 0 &&
          payouts.every(
            (payout) =>
              payout.status === 'paid' ||
              payout.status === 'cancelled' ||
              (payout.status === 'on_hold' &&
                Boolean(payout.holdReason?.trim())),
          );
        if (!payoutReady)
          throw conflict(
            'A provider payout must be paid or held with a reason before closure.',
          );
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'closed', closedAt: ctx.now, closedBy: user.id },
        });
        await ctx.tx.assignment.updateMany({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          data: { status: 'completed' },
        });
        ctx.timers.stop(Object.values(TimerKinds));
        ctx.audit('Job closed', { note: dto.note });
        ctx.notify('request.closed', { requestCode: ctx.snap.number });
      },
    );
  }
}
