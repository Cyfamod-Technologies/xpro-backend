import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requireAnyPermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import {
  blockedReviewDueAt,
  noShowCheckDueAt,
  staleEscalationDueAt,
  staleUpdateDueAt,
} from '../domain/execution-timers';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class HoldsService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async hold(
    userId: string,
    requestId: string,
    dto: {
      reason: string;
      kind: 'staff' | 'no_show' | 'provider_suspended' | 'customer_suspended';
      customerNote?: string;
    },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requireAnyPermission(actor, ['progress.review', 'dispatch.manage']);
    return this.runner.run(
      {
        command: 'request.hold',
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
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            status: 'blocked',
            holdKind: dto.kind,
            holdBy: userId,
            holdReason: dto.reason.trim(),
            holdAt: ctx.now,
            holdPreviousStatus: ctx.snap.status,
          },
        });
        ctx.timers.stop(['T13.noShowCheck', 'T15.stale', 'T15.escalate']);
        ctx.approvals.close('progress', ctx.snap.id, 'hold');
        ctx.timers.start(
          'T16.review',
          blockedReviewDueAt(ctx.now, ctx.settings),
        );
        ctx.audit('Job put on hold', {
          note: dto.reason,
          changes: { kind: dto.kind, previousStatus: ctx.snap.status },
        });
        ctx.notify('request.on_hold', {
          requestCode: ctx.snap.number,
          reason: dto.reason,
        });
        ctx.notify('request.on_hold_customer', {
          requestCode: ctx.snap.number,
          note:
            dto.customerNote?.trim() ||
            `XPro has paused work on ${ctx.snap.number}. We'll update you shortly.`,
        });
      },
    );
  }

  async releaseHold(
    user: RequestUser,
    requestId: string,
    dto: { note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireAnyPermission(actor, ['progress.review', 'dispatch.manage']);
    return this.runner.run(
      {
        command: 'request.releaseHold',
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
        const row = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: { holdPreviousStatus: true, holdKind: true },
        });
        // 04 §6.15 rows 1 to 3 are the runner guard; the previous status is a row column.
        if (!row?.holdPreviousStatus) throw conflict("This job isn't on hold.");
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            status: row.holdPreviousStatus,
            holdKind: null,
            holdBy: null,
            holdReason: null,
            holdAt: null,
            holdPreviousStatus: null,
          },
        });
        ctx.timers.stop('T16.review');
        ctx.approvals.close('blocker', ctx.snap.id, 'hold_released');
        if (row.holdPreviousStatus === 'scheduled') {
          const schedule = await ctx.tx.schedule.findFirst({
            where: { requestId: ctx.snap.id, status: 'confirmed' },
            orderBy: { proposedAt: 'desc' },
          });
          if (schedule)
            ctx.timers.start(
              'T13.noShowCheck',
              noShowCheckDueAt(schedule.startAt, ctx.settings),
              schedule.id,
            );
        } else {
          ctx.timers.start(
            'T15.stale',
            staleUpdateDueAt(ctx.now, ctx.settings),
          );
          ctx.timers.start(
            'T15.escalate',
            staleEscalationDueAt(ctx.now, ctx.settings),
          );
        }
        ctx.audit('Hold released', { note: dto.note });
        ctx.notify('request.hold_released', { requestCode: ctx.snap.number });
        ctx.notify('request.hold_released_customer', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }
}
