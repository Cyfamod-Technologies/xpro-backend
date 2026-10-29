import { Injectable } from '@nestjs/common';
import { DispatchTrigger } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { ENGINE_ACTOR } from '../../platform/actor/actor.types';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { toActorView } from '../actor-view';
import { RequestCommandRunner } from '../command-runner';
import { DISPATCH_GUARDS } from '../domain/dispatch-guards';
import { SETTINGS_REGISTRY } from '../../platform/settings/settings.registry';
import { runAutoDispatch } from './dispatch-engine';
import { ProviderDispatchLoader } from './provider-dispatch.loader';

@Injectable()
export class DispatchTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly runner: RequestCommandRunner,
    private readonly providers: ProviderDispatchLoader,
  ) {
    registry.register('T1.reminder', (timer) => this.remind(timer));
    registry.register('T1.expire', (timer) => this.expire(timer));
    registry.register('T3.review', (timer) => this.reviewDeadline(timer));
    registry.register('dispatch.cascade', (timer) => this.cascade(timer));
  }

  private async remind(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T1.reminder',
      timer.requestId,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'offered',
          },
        });
        if (!assignment || assignment.expiresAt <= ctx.now)
          return { changed: false };
        ctx.notify('assignment.reminder', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
          service: '',
          district: '',
        });
      },
      { bumpVersion: false },
    );
  }

  private async expire(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T1.expire',
      timer.requestId,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: { id: timer.refId, requestId: ctx.snap.id },
          include: {
            request: { select: { dispatchMode: true, autoAttempts: true } },
          },
        });
        if (
          !assignment ||
          assignment.status !== 'offered' ||
          assignment.expiresAt > ctx.now
        )
          return { changed: false };
        const result = await ctx.tx.assignment.updateMany({
          where: {
            id: assignment.id,
            status: 'offered',
            expiresAt: { lte: ctx.now },
          },
          data: {
            status: 'expired',
            endReason: 'expired',
            endedAt: ctx.now,
            endedBy: null,
          },
        });
        if (!result.count) return { changed: false };
        await ctx.tx.providerReliabilityEvent.createMany({
          data: [
            {
              providerId: assignment.providerId,
              kind: 'expired',
              sourceId: assignment.id,
              requestId: assignment.requestId,
              occurredAt: ctx.now,
            },
          ],
          skipDuplicates: true,
        });
        const max = Number(
          ctx.settings['assignment.maxAutoAttempts'] ??
            SETTINGS_REGISTRY['assignment.maxAutoAttempts'].defaultValue,
        );
        const auto =
          assignment.request.dispatchMode === 'auto' &&
          assignment.request.autoAttempts < max;
        await ctx.tx.serviceRequest.update({
          where: { id: assignment.requestId },
          data: {
            status: 'under_review',
            needsAssignmentReason: auto
              ? null
              : assignment.request.autoAttempts >= max
                ? 'limit_reached'
                : 'expired',
          },
        });
        ctx.audit('Offer expired', {
          changes: { assignmentId: assignment.id },
        });
        ctx.notify('assignment.expired', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
          service: '',
          district: '',
        });
        if (auto) ctx.enqueueCascade('cascade');
        else {
          ctx.approvals.open('needs_assignment', ctx.snap.id);
          ctx.notify('request.needs_manual_assignment', {
            requestCode: ctx.snap.number,
          });
        }
      },
    );
  }

  private async reviewDeadline(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.T3.review',
      timer.requestId,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: timer.refId,
            requestId: ctx.snap.id,
            status: 'pending_approval',
          },
          select: { id: true },
        });
        if (!assignment) return { changed: false };
        ctx.notify('assignment.accepted', { requestCode: ctx.snap.number });
      },
      { bumpVersion: false },
    );
  }

  private async cascade(timer: RequestTimer) {
    await this.runner.runSystem(
      'timer.dispatch.cascade',
      timer.requestId,
      async (ctx) => {
        // 04 §6.6: intake approved, no current assignment, no pending cancellation, customer not suspended.
        if (
          !DISPATCH_GUARDS['dispatch.cascade'](
            ctx.snap,
            toActorView(ctx.actor),
            undefined,
            ctx.now,
            ctx.settings,
          ).ok
        )
          return { changed: false };
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) return { changed: false };
        const max = Number(
          ctx.settings['assignment.maxAutoAttempts'] ??
            SETTINGS_REGISTRY['assignment.maxAutoAttempts'].defaultValue,
        );
        if (request.dispatchMode !== 'auto' || request.autoAttempts >= max) {
          // 04 §6.6: a manual request keeps the reason it already has (declined, acceptance_rejected, ...).
          const reason =
            request.dispatchMode !== 'auto' && request.needsAssignmentReason
              ? request.needsAssignmentReason
              : request.autoAttempts >= max
                ? 'limit_reached'
                : 'manual_mode';
          if (reason !== request.needsAssignmentReason)
            await ctx.tx.serviceRequest.update({
              where: { id: request.id },
              data: { needsAssignmentReason: reason },
            });
          ctx.approvals.open('needs_assignment', request.id);
          ctx.audit('Automatic assignment needs staff', {
            changes: { reason },
          });
          ctx.notify('request.needs_manual_assignment', {
            requestCode: ctx.snap.number,
          });
          return;
        }
        await runAutoDispatch(this.providers, ctx, {
          trigger: cascadeTrigger(timer),
          actorId: null,
          request,
          attemptsBefore: request.autoAttempts,
        });
      },
      { actor: ENGINE_ACTOR },
    );
  }
}

/** The enqueuing command's trigger (04 §4.4); an absent or unknown value is a plain `cascade`. */
export function cascadeTrigger(
  timer: Pick<RequestTimer, 'payload'>,
): DispatchTrigger {
  const payload = timer.payload;
  const trigger =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload['trigger']
      : null;
  return typeof trigger === 'string' &&
    (Object.values(DispatchTrigger) as string[]).includes(trigger)
    ? (trigger as DispatchTrigger)
    : DispatchTrigger.cascade;
}
