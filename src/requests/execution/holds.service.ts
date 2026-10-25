import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requireAnyPermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';

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
        ctx.timers.start(
          'T16.review',
          new Date(ctx.now.getTime() + 8 * 60 * 60_000),
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
        // 04 §6.15 row 1 is the runner guard; the previous status is a row column the snapshot lacks.
        if (!row?.holdPreviousStatus) throw conflict("This job isn't on hold.");
        if (row.holdPreviousStatus === 'scheduled') {
          const schedule = await ctx.tx.schedule.findFirst({
            where: { requestId: ctx.snap.id, status: 'confirmed' },
            orderBy: { proposedAt: 'desc' },
          });
          if (schedule && schedule.endAt < ctx.now)
            throw conflict(
              'The confirmed date has passed. Propose a new date before releasing the hold.',
            );
        }
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
        if (row.holdPreviousStatus === 'scheduled') {
          const schedule = await ctx.tx.schedule.findFirst({
            where: { requestId: ctx.snap.id, status: 'confirmed' },
            orderBy: { proposedAt: 'desc' },
          });
          if (schedule)
            ctx.timers.start(
              'T13.noShowCheck',
              new Date(schedule.startAt.getTime() + 2 * 60 * 60_000),
              schedule.id,
            );
        } else
          ctx.timers.start(
            'T15.stale',
            new Date(ctx.now.getTime() + 3 * 86_400_000),
          );
        ctx.audit('Hold released', { note: dto.note });
        ctx.notify('request.hold_released', { requestCode: ctx.snap.number });
        ctx.notify('request.hold_released_customer', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }
}
