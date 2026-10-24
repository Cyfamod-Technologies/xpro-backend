import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../platform/actor/actor.service';
import { requireCustomer, requirePermission, requireProvider } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import { checkScheduleInterval } from '../domain/schedule-checks';
import type { WorkingHours, TimeOff } from '../../platform/calendar/provider-calendar';

const conflict = (message: string) => new AppError(409, 'STATE_CONFLICT', message);
const fail = (message: string) => new AppError(422, 'VALIDATION_ERROR', message);

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService, private readonly actors: ActorService, private readonly runner: RequestCommandRunner) {}

  async propose(userId: string, requestId: string, dto: { startAt: string; endAt: string; note?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'schedule.manage');
    return this.runner.run({ command: 'schedule.propose', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      if (!['ready_to_schedule', 'scheduled'].includes(ctx.snap.status)) {
        if (ctx.snap.status === 'awaiting_payment') throw conflict("The customer hasn't paid yet. Schedule once payment is received.");
        throw conflict('An accepted quote and provider assignment are required for scheduling.');
      }
      if (ctx.snap.providerStanding !== 'active') throw conflict('This provider is suspended. Replace them or wait for reactivation.');
      const assignment = await ctx.tx.assignment.findFirst({ where: { requestId: ctx.snap.id, status: 'accepted' }, orderBy: { createdAt: 'desc' } });
      const quote = await ctx.tx.quote.findFirst({ where: { requestId: ctx.snap.id, status: 'accepted' }, orderBy: { version: 'desc' } });
      if (!assignment || !quote) throw conflict('An accepted quote and provider assignment are required for scheduling.');
      if (quote.payoutAssignmentId !== assignment.id || quote.payoutAmount == null) throw conflict("Set the new provider's payout before scheduling.");
      await ctx.tx.$queryRaw(Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${assignment.providerId} FOR UPDATE`);
      const profile = await ctx.tx.providerProfile.findUnique({ where: { id: assignment.providerId }, select: { workingHours: true, timeOff: true, reliabilityStatus: true } });
      if (!profile || profile.reliabilityStatus === 'suspended') throw conflict('This provider is suspended. Replace them or wait for reactivation.');
      const startAt = new Date(dto.startAt); const endAt = new Date(dto.endAt);
      const overlap = await ctx.tx.schedule.findFirst({ where: { providerId: assignment.providerId, status: { in: ['proposed', 'confirmed'] }, startAt: { lt: endAt }, endAt: { gt: startAt }, requestId: { not: ctx.snap.id } }, select: { id: true } });
      const providerName = ctx.snap.providerCard?.businessName || ctx.snap.providerCard?.firstName || 'This provider';
      const problem = checkScheduleInterval({ startAt, endAt, now: ctx.now, provider: { workingHours: profile.workingHours as WorkingHours, timeOff: profile.timeOff as unknown as TimeOff[], displayName: providerName }, overlaps: Boolean(overlap) });
      if (problem) throw conflict(problem);
      const current = await ctx.tx.schedule.findFirst({ where: { requestId: ctx.snap.id, status: 'confirmed' }, orderBy: { proposedAt: 'desc' } });
      await ctx.tx.schedule.updateMany({ where: { requestId: ctx.snap.id, status: { in: ['proposed', 'changes_requested'] } }, data: { status: 'cancelled' } });
      const changeRequests = current?.changeRequests ?? [];
      const schedule = await ctx.tx.schedule.create({ data: { requestId: ctx.snap.id, assignmentId: assignment.id, providerId: assignment.providerId, quoteId: quote.id, startAt, endAt, note: dto.note?.trim() || null, status: 'proposed', customer: 'pending', provider: 'pending', proposedBy: userId, proposedAt: ctx.now, replacesScheduleId: current?.id ?? null, changeRequests } });
      ctx.timers.start('T11.reminder24h', new Date(ctx.now.getTime() + 24 * 60 * 60_000), schedule.id);
      ctx.timers.start('T11.staff48h', new Date(ctx.now.getTime() + 48 * 60 * 60_000), schedule.id);
      ctx.audit('Schedule proposed', { resourceType: 'schedule', resourceId: schedule.id });
      ctx.notify('schedule.proposed_customer', { requestCode: ctx.snap.number, startAt: watTime(startAt), endAt: watTime(endAt) });
      ctx.notify('schedule.proposed_provider', { requestCode: ctx.snap.number, startAt: watTime(startAt), endAt: watTime(endAt) });
    });
  }

  async respond(user: RequestUser, requestId: string, scheduleId: string, dto: { accept: boolean; note?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind === 'customer') requireCustomer(actor);
    else if (actor.kind === 'provider') requireProvider(actor);
    else throw new AppError(403, 'FORBIDDEN', 'This action is not available for your account type.');
    if (!dto.accept && !dto.note?.trim()) throw fail('Explain your requested schedule change.');
    return this.runner.run({ command: 'schedule.respond', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const schedule = await ctx.tx.schedule.findFirst({ where: { id: scheduleId, requestId: ctx.snap.id } });
      if (!schedule || schedule.status !== 'proposed' || ctx.snap.currentSchedule?.status !== 'proposed') throw conflict('This schedule is no longer awaiting confirmation.');
      const party = actor.kind === 'customer' ? 'customer' : 'provider';
      if (party === 'customer' && ctx.actor.userId !== ctx.snap.ownerId) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      if (party === 'provider' && ctx.actor.userId !== ctx.snap.currentProviderUserId) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      if (schedule[party] !== 'pending') throw conflict('Your response has already been recorded.');
      const update = { [party]: dto.accept ? 'accepted' as const : 'changes_requested' as const };
      const other = party === 'customer' ? schedule.provider : schedule.customer;
      if (!dto.accept) {
        await ctx.tx.schedule.update({ where: { id: scheduleId }, data: { ...update, status: 'changes_requested', responses: { push: `${party === 'customer' ? 'Customer' : 'Provider'}: ${dto.note!.trim()}` } } });
        ctx.audit('Schedule change requested', { resourceType: 'schedule', resourceId: scheduleId, note: dto.note });
        ctx.notify('schedule.change_requested', { requestCode: ctx.snap.number });
      } else if (other === 'accepted') {
        const profile = await ctx.tx.providerProfile.findUnique({ where: { id: schedule.providerId }, select: { workingHours: true, timeOff: true } });
        const excludedIds = [scheduleId, ...(schedule.replacesScheduleId ? [schedule.replacesScheduleId] : [])];
        const overlap = await ctx.tx.schedule.findFirst({ where: { providerId: schedule.providerId, status: { in: ['proposed', 'confirmed'] }, id: { notIn: excludedIds }, startAt: { lt: schedule.endAt }, endAt: { gt: schedule.startAt } }, select: { id: true } });
        const providerName = ctx.snap.providerCard?.businessName || ctx.snap.providerCard?.firstName || 'This provider';
        const problem = profile ? checkScheduleInterval({ startAt: schedule.startAt, endAt: schedule.endAt, now: new Date(ctx.now.getTime() - 1), provider: { workingHours: profile.workingHours as WorkingHours, timeOff: profile.timeOff as unknown as TimeOff[], displayName: providerName }, overlaps: Boolean(overlap) }) : 'This provider is suspended. Replace them or wait for reactivation.';
        if (problem) throw conflict('This date no longer works for the provider. XPro will propose a new one.');
        if (schedule.replacesScheduleId) await ctx.tx.schedule.updateMany({ where: { id: schedule.replacesScheduleId, status: 'confirmed' }, data: { status: 'superseded' } });
        await ctx.tx.schedule.update({ where: { id: scheduleId }, data: { ...update, status: 'confirmed', confirmedAt: ctx.now, responses: { push: `${party === 'customer' ? 'Customer' : 'Provider'}: Confirmed` } } });
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'scheduled' } });
        ctx.timers.stop(['T11.reminder24h', 'T11.staff48h'], scheduleId);
        ctx.timers.start('T12.reminder24h', new Date(schedule.startAt.getTime() - 24 * 60 * 60_000), scheduleId);
        ctx.timers.start('T12.reminder2h', new Date(schedule.startAt.getTime() - 2 * 60 * 60_000), scheduleId);
        ctx.timers.start('T13.noShowCheck', new Date(schedule.startAt.getTime() + 2 * 60 * 60_000), scheduleId);
        ctx.audit('Schedule confirmed', { resourceType: 'schedule', resourceId: scheduleId });
        ctx.notify('schedule.confirmed_customer', { requestCode: ctx.snap.number });
        ctx.notify('schedule.confirmed_provider', { requestCode: ctx.snap.number });
      } else {
        await ctx.tx.schedule.update({ where: { id: scheduleId }, data: { ...update, responses: { push: `${party === 'customer' ? 'Customer' : 'Provider'}: Confirmed` } } });
        ctx.audit('Schedule response recorded', { resourceType: 'schedule', resourceId: scheduleId });
        ctx.notify('schedule.response_recorded', { requestCode: ctx.snap.number });
      }
    });
  }

  async requestChange(user: RequestUser, requestId: string, scheduleId: string, dto: { note: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind !== 'customer' && actor.kind !== 'provider') throw new AppError(403, 'FORBIDDEN', 'This action is not available for your account type.');
    return this.runner.run({ command: 'schedule.requestChange', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const schedule = await ctx.tx.schedule.findFirst({ where: { id: scheduleId, requestId: ctx.snap.id, status: 'confirmed' } });
      if (!schedule) throw conflict('This schedule is no longer confirmed.');
      const party = actor.kind;
      if ((party === 'customer' && user.id !== ctx.snap.ownerId) || (party === 'provider' && user.id !== ctx.snap.currentProviderUserId)) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      const requests = Array.isArray(schedule.changeRequests) ? schedule.changeRequests as Array<Record<string, unknown>> : [];
      if (requests.some((item) => item.party === party && !item.handledAt)) throw conflict('Your date change request is already with XPro.');
      await ctx.tx.schedule.update({ where: { id: schedule.id }, data: { changeRequests: [...requests, { party, note: dto.note.trim(), createdAt: ctx.now.toISOString(), urgent: schedule.startAt.getTime() - ctx.now.getTime() <= 48 * 60 * 60_000, handledAt: null }] } });
      ctx.audit('Reschedule requested', { resourceType: 'schedule', resourceId: schedule.id, note: dto.note });
      ctx.notify('schedule.reschedule_requested', { requestCode: ctx.snap.number });
    });
  }
}

const watTime = (date: Date) => date.toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' });
