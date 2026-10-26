import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PaymentsService } from '../../payments/payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import type { RequestUser } from '../../common/types/request-user';
import { toActorView } from '../actor-view';
import type { CommandContext } from '../command-runner';
import { RequestCommandRunner } from '../command-runner';
import {
  DEFAULT_CUSTOMER_REASON,
  workStartedOn,
} from '../domain/cancellation-rules';
import { isOwner } from '../domain/guards/common';
import { canFreeCancel } from '../domain/intake-guards';
import { IntakeService } from '../intake.service';
import { RequestSnapshotLoader } from '../snapshot.loader';
import {
  cleanupCancelledRequest,
  restartAutoConfirm,
} from './cancellation-cleanup';
import type { CancelRequestDto } from './cancellation.dto';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
// new message: not in spec
const NOT_AWAITING_DECISION =
  'This cancellation request is no longer awaiting a decision.';
// new message: not in spec
const WITHDRAWN_NOTE = 'Withdrawn by customer.';

type Idempotency = { url: string; key?: string };

@Injectable()
export class CancellationService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly payments: PaymentsService,
    private readonly intake: IntakeService,
    private readonly loader: RequestSnapshotLoader,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `POST /requests/:id/cancel` (04 §11.2): one route, dispatched by actor and
   * state. The owner gets a free cancel while that is allowed and a pending
   * cancellation request after; staff get a direct cancel. The command's own
   * guard re-checks everything inside the lock, so the peek below only picks the
   * command and leaks nothing to a caller who can't see the request.
   */
  async cancel(
    user: RequestUser,
    requestRef: string,
    dto: CancelRequestDto,
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    const loaded = await this.loader.load(this.prisma, requestRef);
    if (!loaded)
      throw new AppError(
        404,
        'NOT_FOUND',
        'This request is no longer available to your account.',
      );
    const view = toActorView(actor);
    if (isOwner(loaded.snapshot, view)) {
      const free = canFreeCancel(
        loaded.snapshot,
        view,
        undefined,
        new Date(),
        {},
      );
      if (free.ok)
        return this.intake.freeCancel(user, requestRef, dto, version, url, key);
      return this.request(user, requestRef, dto, version, url, key);
    }
    if (actor.staff)
      return this.staffCancel(user.id, requestRef, dto, version, url, key);
    return this.request(user, requestRef, dto, version, url, key);
  }

  async request(
    user: RequestUser,
    requestId: string,
    dto: { reasonCode?: string; note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireCustomer(actor);
    return this.runner.run(
      {
        command: 'cancellation.request',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        input: dto,
        ...this.idempotency({ url, key }, dto),
      },
      async (ctx) => {
        const note = dto.note.trim();
        const row = await ctx.tx.cancellation.create({
          data: {
            requestId: ctx.snap.id,
            requestedBy: 'customer',
            requestedById: user.id,
            reasonCode: (dto.reasonCode ?? DEFAULT_CUSTOMER_REASON) as never,
            note,
            stage: ctx.snap.status,
            paid: ctx.snap.payment.paid,
            workStarted: workStartedOn(ctx.snap),
          },
        });
        ctx.timers.start(
          TimerKinds.T19Followup,
          new Date(ctx.now.getTime() + 48 * 60 * 60_000),
          row.id,
        );
        // 02 §6.11: the item starts at the request; T19 only follows up.
        ctx.approvals.open('cancellation', row.id);
        ctx.audit('Cancellation requested', {
          resourceType: 'cancellation',
          resourceId: row.id,
          note,
          changes: { reasonCode: row.reasonCode },
        });
        ctx.notify('cancellation.requested', { requestCode: ctx.snap.number });
      },
    );
  }

  async withdraw(
    user: RequestUser,
    requestId: string,
    dto: { note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireCustomer(actor);
    return this.runner.run(
      {
        command: 'cancellation.withdraw',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        input: dto,
        ...this.idempotency({ url, key }, dto),
      },
      async (ctx) => {
        const row = await ctx.tx.cancellation.findFirst({
          where: {
            requestId: ctx.snap.id,
            status: 'pending',
            requestedBy: 'customer',
            requestedById: user.id,
          },
        });
        if (!row) throw conflict(NOT_AWAITING_DECISION);
        await ctx.tx.cancellation.update({
          where: { id: row.id },
          data: {
            status: 'withdrawn',
            decidedAt: ctx.now,
            decisionNote: dto.note?.trim() || WITHDRAWN_NOTE,
          },
        });
        ctx.timers.stop(TimerKinds.T19Followup, row.id);
        ctx.approvals.close('cancellation', row.id, 'withdrawn');
        await restartAutoConfirm(ctx);
        ctx.audit('Cancellation request withdrawn', {
          resourceType: 'cancellation',
          resourceId: row.id,
          note: dto.note,
        });
      },
    );
  }

  async decide(
    userId: string,
    requestId: string,
    dto: { approve: boolean; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'request.cancel');
    return this.runner.run(
      {
        command: 'cancellation.decide',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        input: dto,
        // 02 §6.5: a rejection claims an unclaimed request; an approval ends it.
        autoClaim: true,
        ...this.idempotency({ url, key }, dto),
      },
      async (ctx) => {
        const row = await ctx.tx.cancellation.findFirst({
          where: { requestId: ctx.snap.id, status: 'pending' },
          orderBy: { createdAt: 'desc' },
        });
        // The runner guard checked the permission tier, the reject note and the payment window against this transaction's own snapshot (paid from payments, workStarted from the assignments), so it already used the recomputed values.
        if (!row) throw conflict(NOT_AWAITING_DECISION);
        const paid = ctx.snap.payment.paid;
        const workStarted = workStartedOn(ctx.snap);
        await ctx.tx.cancellation.update({
          where: { id: row.id },
          data: { paid, workStarted },
        });
        if (!dto.approve) {
          await ctx.tx.cancellation.update({
            where: { id: row.id },
            data: {
              status: 'rejected',
              decidedBy: userId,
              decidedAt: ctx.now,
              decisionNote: dto.note!.trim(),
            },
          });
          ctx.timers.stop(TimerKinds.T19Followup, row.id);
          ctx.approvals.close('cancellation', row.id, 'rejected');
          // 02 §6.11: a declined quote whose cancellation is rejected goes back to Pricing for a revision.
          if (ctx.snap.latestQuote?.status === 'declined') {
            const declined = await ctx.tx.quote.findFirst({
              where: { requestId: ctx.snap.id, status: 'declined' },
              orderBy: { version: 'desc' },
              select: { id: true },
            });
            if (declined) ctx.approvals.open('quote_followup', declined.id);
          }
          await restartAutoConfirm(ctx);
          ctx.audit('Cancellation rejected', {
            resourceType: 'cancellation',
            resourceId: row.id,
            note: dto.note,
          });
          ctx.notify('cancellation.rejected', { requestCode: ctx.snap.number });
          return;
        }
        await this.finish(ctx, {
          cancellationId: row.id,
          actorUserId: userId,
          paid,
          workStarted,
          decisionNote: dto.note?.trim() || null,
        });
        ctx.audit('Cancellation approved', {
          resourceType: 'cancellation',
          resourceId: row.id,
          note: dto.note,
          changes: { paid, workStarted },
        });
        ctx.notify('cancellation.approved', { requestCode: ctx.snap.number });
      },
    );
  }

  /** 04 §2.1, §5.2 #6, #12, #24: staff cancel directly, with the same effects as an approved cancellation. */
  async staffCancel(
    userId: string,
    requestId: string,
    dto: CancelRequestDto,
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'request.cancel');
    return this.runner.run(
      {
        command: 'request.cancel',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        input: dto,
        ...this.idempotency({ url, key }, dto),
      },
      async (ctx) => {
        // The runner guard checked the reason, the note, the pending cancellation, the payment window and `request.cancel.active` for a paid or started job.
        const note = dto.note.trim();
        const paid = ctx.snap.payment.paid;
        const workStarted = workStartedOn(ctx.snap);
        const row = await ctx.tx.cancellation.create({
          data: {
            requestId: ctx.snap.id,
            requestedBy: 'staff',
            requestedById: userId,
            reasonCode: dto.reasonCode as never,
            note,
            stage: ctx.snap.status,
          },
        });
        await this.finish(ctx, {
          cancellationId: row.id,
          actorUserId: userId,
          paid,
          workStarted,
          decisionNote: null,
        });
        ctx.audit('Request cancelled', {
          resourceType: 'cancellation',
          resourceId: row.id,
          note,
          changes: {
            reasonCode: dto.reasonCode,
            cancellationId: row.id,
            paid,
            workStarted,
          },
        });
        ctx.notify('cancellation.staff_cancelled', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }

  /**
   * What an approved cancellation does, for `decide` and `staffCancel` alike
   * (04 §6.21): clean up, then `cancelled` when unpaid or `cancelling` with the
   * refunds opened when paid (05 §6.4). The assignment ends now, so the provider
   * hears about it now and the refund settlement has nothing left to end.
   */
  private async finish(
    ctx: CommandContext,
    input: {
      cancellationId: string;
      actorUserId: string;
      paid: boolean;
      workStarted: boolean;
      decisionNote: string | null;
    },
  ) {
    const { cancellationId, actorUserId, paid, workStarted } = input;
    const { compensationCandidateIds, ended } = await cleanupCancelledRequest(
      ctx,
      actorUserId,
    );
    await ctx.tx.cancellation.update({
      where: { id: cancellationId },
      data: {
        status: paid ? 'approved' : 'completed',
        decidedBy: actorUserId,
        decidedAt: ctx.now,
        decisionNote: input.decisionNote,
        paid,
        workStarted,
        refundDue: paid,
        compensationCandidateIds,
      },
    });
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: { status: paid ? 'cancelling' : 'cancelled', cancellationId },
    });
    if (paid)
      await this.payments.openForCancellation(ctx, {
        cancellationId,
        requestedBy: actorUserId,
        workStarted,
      });
    for (const assignment of ended)
      ctx.notify('cancellation.completed_provider', {
        requestCode: ctx.snap.number,
        assignmentId: assignment.id,
        providerUserId: assignment.providerUserId,
      });
  }

  private idempotency(options: Idempotency, dto: object) {
    return options.key
      ? {
          idempotencyKey: options.key,
          idempotencyHash: hashRequest('POST', options.url, dto),
        }
      : {};
  }
}
