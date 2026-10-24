import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requireCustomer, requirePermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PaymentsService } from '../../payments/payments.service';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';

const conflict = (message: string) => new AppError(409, 'STATE_CONFLICT', message);
const invalid = (message: string) => new AppError(422, 'VALIDATION_ERROR', message);

@Injectable()
export class CancellationService {
  constructor(private readonly actors: ActorService, private readonly runner: RequestCommandRunner, private readonly payments: PaymentsService) {}

  async request(user: RequestUser, requestId: string, dto: { reasonCode: string; note: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(user.id); requireCustomer(actor);
    return this.runner.run({ command: 'cancellation.request', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      if (user.id !== ctx.snap.ownerId) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      if (['closed', 'cancelled', 'rejected', 'cancelling'].includes(ctx.snap.status)) throw conflict('This request can no longer be cancelled.');
      if (ctx.snap.pendingCancellation) throw conflict('Your cancellation request is already awaiting XPro.');
      const workStarted = ctx.snap.status === 'in_progress' || ctx.snap.status === 'blocked';
      const row = await ctx.tx.cancellation.create({ data: { requestId: ctx.snap.id, requestedBy: 'customer', requestedById: user.id, reasonCode: dto.reasonCode as never, note: dto.note.trim(), stage: ctx.snap.status, paid: ctx.snap.payment.paid, workStarted } });
      ctx.timers.start(TimerKinds.T19Followup, new Date(ctx.now.getTime() + 48 * 60 * 60_000), row.id);
      ctx.audit('Cancellation requested', { resourceType: 'cancellation', resourceId: row.id, note: dto.note });
      ctx.notify('cancellation.requested', { requestCode: ctx.snap.number });
    });
  }

  async withdraw(user: RequestUser, requestId: string, cancellationId: string, dto: { note?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(user.id); requireCustomer(actor);
    return this.runner.run({ command: 'cancellation.withdraw', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const row = await ctx.tx.cancellation.findFirst({ where: { id: cancellationId, requestId: ctx.snap.id, status: 'pending', requestedBy: 'customer', requestedById: user.id } });
      if (!row) throw conflict('This cancellation request is no longer awaiting a decision.');
      await ctx.tx.cancellation.update({ where: { id: row.id }, data: { status: 'withdrawn', decidedAt: ctx.now, decisionNote: dto.note?.trim() || 'Withdrawn by customer.' } });
      ctx.timers.stop(TimerKinds.T19Followup, row.id);
      ctx.audit('Cancellation request withdrawn', { resourceType: 'cancellation', resourceId: row.id, note: dto.note });
    });
  }

  async decide(userId: string, requestId: string, dto: { approve: boolean; note?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'request.cancel');
    return this.runner.run({ command: 'cancellation.decide', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const row = await ctx.tx.cancellation.findFirst({ where: { requestId: ctx.snap.id, status: 'pending' }, orderBy: { createdAt: 'desc' } });
      if (!row) throw conflict('This cancellation request is no longer awaiting a decision.');
      if (row.paid || row.workStarted) requirePermission(actor, 'request.cancel.active');
      if (!dto.approve && !dto.note?.trim()) throw invalid('Add a reason for rejecting this cancellation request.');
      const pendingPayment = await ctx.tx.payment.findFirst({ where: { requestId: ctx.snap.id, status: 'pending', createdAt: { gte: new Date(ctx.now.getTime() - 30 * 60_000) } }, select: { id: true } });
      if (dto.approve && pendingPayment) throw conflict('A payment is still processing. Try again shortly.');
      if (!dto.approve) {
        await ctx.tx.cancellation.update({ where: { id: row.id }, data: { status: 'rejected', decidedBy: userId, decidedAt: ctx.now, decisionNote: dto.note!.trim() } });
        ctx.timers.stop(TimerKinds.T19Followup, row.id); ctx.audit('Cancellation rejected', { resourceType: 'cancellation', resourceId: row.id, note: dto.note }); ctx.notify('cancellation.rejected', { requestCode: ctx.snap.number }); return;
      }
      const workStarted = row.workStarted || ctx.snap.status === 'in_progress' || ctx.snap.status === 'blocked';
      const acceptedAssignment = await ctx.tx.assignment.findFirst({ where: { requestId: ctx.snap.id, status: 'accepted' }, select: { id: true } });
      await ctx.tx.cancellation.update({ where: { id: row.id }, data: { status: row.paid ? 'approved' : 'completed', decidedBy: userId, decidedAt: ctx.now, decisionNote: dto.note?.trim() || null, workStarted, refundDue: row.paid, compensationCandidateIds: workStarted && acceptedAssignment ? [acceptedAssignment.id] : [] } });
      await ctx.tx.assignment.updateMany({ where: { requestId: ctx.snap.id, status: { in: ['offered', 'pending_approval'] } }, data: { status: 'withdrawn', endedAt: ctx.now, endedBy: userId, endReason: 'request_cancelled' } });
      await ctx.tx.schedule.updateMany({ where: { requestId: ctx.snap.id, status: { in: ['proposed', 'confirmed', 'changes_requested'] } }, data: { status: 'cancelled' } });
      ctx.timers.stop(Object.values(TimerKinds));
      if (row.paid) {
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'cancelling', cancellationId: row.id } });
        await this.payments.openForCancellation(ctx.tx, { requestId: ctx.snap.id, cancellationId: row.id, requestedBy: userId, workStarted, now: ctx.now });
      } else await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'cancelled', cancellationId: row.id } });
      ctx.audit('Cancellation approved', { resourceType: 'cancellation', resourceId: row.id, note: dto.note });
      ctx.notify('cancellation.approved', { requestCode: ctx.snap.number });
    });
  }
}
