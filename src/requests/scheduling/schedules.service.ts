import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
  requireProvider,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/types/request-user';
import { closeOpenApprovals } from '../approval-effects';
import { RequestCommandRunner } from '../command-runner';
import {
  appendChangeRequest,
  hasOpenChangeRequest,
  markChangeRequestsHandled,
  readChangeRequests,
} from '../domain/change-requests';
import { noShowCheckDueAt } from '../domain/execution-timers';
import { providerBlocked } from '../domain/provider-standing';
import {
  checkScheduleInterval,
  SECOND_CONFIRMATION_MESSAGE,
} from '../domain/schedule-checks';
import { mapOverlapViolation } from './overlap-violation';
import type {
  WorkingHours,
  TimeOff,
} from '../../platform/calendar/provider-calendar';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async propose(
    userId: string,
    requestId: string,
    dto: { startAt: string; endAt: string; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'schedule.manage');
    return this.runner.run(
      {
        command: 'schedule.propose',
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
        // Status, replacement payout and standing rows of 04 §6.13 are the runner guard.
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        const quote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        if (!assignment || !quote)
          throw conflict(
            'An accepted quote and provider assignment are required for scheduling.',
          );
        if (
          quote.payoutAssignmentId !== assignment.id ||
          quote.payoutAmount == null
        )
          throw conflict("Set the new provider's payout before scheduling.");
        await ctx.tx.$queryRaw(
          Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${assignment.providerId} FOR UPDATE`,
        );
        const profile = await ctx.tx.providerProfile.findUnique({
          where: { id: assignment.providerId },
          select: {
            workingHours: true,
            timeOff: true,
            verification: true,
            reliabilityStatus: true,
            user: { select: { status: true } },
          },
        });
        // Re-read under the provider lock, after the payout row (04 §6.13 order).
        if (
          !profile ||
          providerBlocked({
            userStatus: profile.user.status,
            verification: profile.verification,
            reliabilityStatus: profile.reliabilityStatus,
          }).blocked
        )
          throw conflict(
            'This provider is suspended. Replace them or wait for reactivation.',
          );
        const startAt = new Date(dto.startAt);
        const endAt = new Date(dto.endAt);
        const overlap = await ctx.tx.schedule.findFirst({
          where: {
            providerId: assignment.providerId,
            status: { in: ['proposed', 'confirmed'] },
            startAt: { lt: endAt },
            endAt: { gt: startAt },
            requestId: { not: ctx.snap.id },
          },
          select: { startAt: true, endAt: true },
          orderBy: { startAt: 'asc' },
        });
        const providerName =
          ctx.snap.providerCard?.businessName ||
          ctx.snap.providerCard?.firstName ||
          'This provider';
        const problem = checkScheduleInterval({
          startAt,
          endAt,
          now: ctx.now,
          provider: {
            workingHours: profile.workingHours as WorkingHours,
            timeOff: profile.timeOff as unknown as TimeOff[],
            displayName: providerName,
          },
          overlap,
        });
        if (problem) throw conflict(problem);
        const current = await ctx.tx.schedule.findFirst({
          where: { requestId: ctx.snap.id, status: 'confirmed' },
          orderBy: { proposedAt: 'desc' },
        });
        await ctx.tx.schedule.updateMany({
          where: {
            requestId: ctx.snap.id,
            status: { in: ['proposed', 'changes_requested'] },
          },
          data: { status: 'cancelled' },
        });
        if (current && readChangeRequests(current.changeRequests).length)
          await ctx.tx.schedule.update({
            where: { id: current.id },
            data: {
              changeRequests: markChangeRequestsHandled(
                current.changeRequests,
                ctx.now,
              ),
            },
          });
        const schedule = await ctx.tx.schedule.create({
          data: {
            requestId: ctx.snap.id,
            assignmentId: assignment.id,
            providerId: assignment.providerId,
            quoteId: quote.id,
            startAt,
            endAt,
            note: dto.note?.trim() || null,
            status: 'proposed',
            customer: 'pending',
            provider: 'pending',
            proposedBy: userId,
            proposedAt: ctx.now,
            replacesScheduleId: current?.id ?? null,
            changeRequests: [],
          },
        });
        ctx.timers.start(
          'T11.reminder24h',
          new Date(ctx.now.getTime() + 24 * 60 * 60_000),
          schedule.id,
        );
        ctx.timers.start(
          'T11.staff48h',
          new Date(ctx.now.getTime() + 48 * 60 * 60_000),
          schedule.id,
        );
        ctx.approvals.close('schedule_needed', ctx.snap.id, 'proposed');
        await closeOpenApprovals(ctx, ['schedule_change'], 'proposed');
        ctx.audit('Schedule proposed', {
          resourceType: 'schedule',
          resourceId: schedule.id,
        });
        ctx.notify('schedule.proposed_customer', {
          requestCode: ctx.snap.number,
          startAt: watTime(startAt),
          endAt: watTime(endAt),
        });
        ctx.notify('schedule.proposed_provider', {
          requestCode: ctx.snap.number,
          startAt: watTime(startAt),
          endAt: watTime(endAt),
        });
      },
    );
  }

  async respond(
    user: RequestUser,
    requestId: string,
    scheduleId: string,
    dto: { accept: boolean; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind === 'customer') requireCustomer(actor);
    else if (actor.kind === 'provider') requireProvider(actor);
    else
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );
    return this.runner.run(
      {
        command: 'schedule.respond',
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
        const schedule = await ctx.tx.schedule.findFirst({
          where: { id: scheduleId, requestId: ctx.snap.id },
        });
        // Guard: the current schedule is `proposed`, this party is `pending` (04 §6.13 respond rows 1-3).
        if (!schedule || schedule.status !== 'proposed')
          throw conflict('This schedule is no longer awaiting confirmation.');
        const party = actor.kind === 'customer' ? 'customer' : 'provider';
        const update = {
          [party]: dto.accept
            ? ('accepted' as const)
            : ('changes_requested' as const),
        };
        const other =
          party === 'customer' ? schedule.provider : schedule.customer;
        if (!dto.accept) {
          await ctx.tx.schedule.update({
            where: { id: scheduleId },
            data: {
              ...update,
              status: 'changes_requested',
              responses: {
                push: `${party === 'customer' ? 'Customer' : 'Provider'}: ${dto.note!.trim()}`,
              },
            },
          });
          // 02 §6.11: a declined slot asks schedule.manage for a new one.
          ctx.approvals.open('schedule_change', scheduleId);
          ctx.audit('Schedule change requested', {
            resourceType: 'schedule',
            resourceId: scheduleId,
            note: dto.note,
          });
          ctx.notify('schedule.change_requested', {
            requestCode: ctx.snap.number,
          });
        } else if (other === 'accepted') {
          // Serialises with every other confirmation for this provider (D-04).
          await ctx.tx.$queryRaw(
            Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${schedule.providerId} FOR UPDATE`,
          );
          const profile = await ctx.tx.providerProfile.findUnique({
            where: { id: schedule.providerId },
            select: {
              workingHours: true,
              timeOff: true,
              verification: true,
              reliabilityStatus: true,
              user: { select: { status: true } },
            },
          });
          const excludedIds = [
            scheduleId,
            ...(schedule.replacesScheduleId
              ? [schedule.replacesScheduleId]
              : []),
          ];
          const overlap = await ctx.tx.schedule.findFirst({
            where: {
              providerId: schedule.providerId,
              status: { in: ['proposed', 'confirmed'] },
              id: { notIn: excludedIds },
              startAt: { lt: schedule.endAt },
              endAt: { gt: schedule.startAt },
            },
            select: { startAt: true, endAt: true },
            orderBy: { startAt: 'asc' },
          });
          const providerName =
            ctx.snap.providerCard?.businessName ||
            ctx.snap.providerCard?.firstName ||
            'This provider';
          if (
            !profile ||
            providerBlocked({
              userStatus: profile.user.status,
              verification: profile.verification,
              reliabilityStatus: profile.reliabilityStatus,
            }).blocked
          )
            throw conflict(SECOND_CONFIRMATION_MESSAGE);
          const problem = checkScheduleInterval({
            startAt: schedule.startAt,
            endAt: schedule.endAt,
            now: new Date(ctx.now.getTime() - 1),
            provider: {
              workingHours: profile.workingHours as WorkingHours,
              timeOff: profile.timeOff as unknown as TimeOff[],
              displayName: providerName,
            },
            overlap,
          });
          if (problem) throw conflict(SECOND_CONFIRMATION_MESSAGE);
          try {
            if (schedule.replacesScheduleId)
              await ctx.tx.schedule.updateMany({
                where: { id: schedule.replacesScheduleId, status: 'confirmed' },
                data: { status: 'superseded' },
              });
            await ctx.tx.schedule.update({
              where: { id: scheduleId },
              data: {
                ...update,
                status: 'confirmed',
                confirmedAt: ctx.now,
                responses: {
                  push: `${party === 'customer' ? 'Customer' : 'Provider'}: Confirmed`,
                },
              },
            });
          } catch (error) {
            // Backstop for a race the provider lock did not cover: schedules_no_confirmed_overlap (23P01).
            throw mapOverlapViolation(error);
          }
          // Only `ready_to_schedule` becomes `scheduled`. A reschedule confirmed
          // while `scheduled` or held before work leaves the status (and hold) alone.
          if (ctx.snap.status === 'ready_to_schedule')
            await ctx.tx.serviceRequest.update({
              where: { id: ctx.snap.id },
              data: { status: 'scheduled' },
            });
          ctx.timers.stop(['T11.reminder24h', 'T11.staff48h'], scheduleId);
          await closeOpenApprovals(ctx, ['schedule_change'], 'confirmed');
          const reminders = [
            ['T12.reminder24h', 24 * 60 * 60_000],
            ['T12.reminder2h', 2 * 60 * 60_000],
          ] as const;
          for (const [kind, lead] of reminders) {
            const dueAt = new Date(schedule.startAt.getTime() - lead);
            if (dueAt > ctx.now) ctx.timers.start(kind, dueAt, scheduleId);
          }
          ctx.timers.start(
            'T13.noShowCheck',
            noShowCheckDueAt(schedule.startAt, ctx.settings),
            scheduleId,
          );
          ctx.audit('Schedule confirmed', {
            resourceType: 'schedule',
            resourceId: scheduleId,
          });
          ctx.notify('schedule.confirmed_customer', {
            requestCode: ctx.snap.number,
          });
          ctx.notify('schedule.confirmed_provider', {
            requestCode: ctx.snap.number,
          });
        } else {
          await ctx.tx.schedule.update({
            where: { id: scheduleId },
            data: {
              ...update,
              responses: {
                push: `${party === 'customer' ? 'Customer' : 'Provider'}: Confirmed`,
              },
            },
          });
          ctx.audit('Schedule response recorded', {
            resourceType: 'schedule',
            resourceId: scheduleId,
          });
          ctx.notify('schedule.response_recorded', {
            requestCode: ctx.snap.number,
          });
        }
      },
    );
  }

  async requestChange(
    user: RequestUser,
    requestId: string,
    scheduleId: string,
    dto: { note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind !== 'customer' && actor.kind !== 'provider')
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );
    return this.runner.run(
      {
        command: 'schedule.requestChange',
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
        const schedule = await ctx.tx.schedule.findFirst({
          where: {
            id: scheduleId,
            requestId: ctx.snap.id,
            status: 'confirmed',
          },
        });
        if (!schedule) throw conflict('This schedule is no longer confirmed.');
        const party = actor.kind === 'customer' ? 'customer' : 'provider';
        if (hasOpenChangeRequest(schedule.changeRequests, party))
          throw conflict('Your date change request is already with XPro.');
        await ctx.tx.schedule.update({
          where: { id: schedule.id },
          data: {
            changeRequests: appendChangeRequest(schedule.changeRequests, {
              by: party,
              note: dto.note.trim(),
              at: ctx.now,
            }),
          },
        });
        ctx.approvals.open('schedule_change', schedule.id);
        ctx.audit('Reschedule requested', {
          resourceType: 'schedule',
          resourceId: schedule.id,
          note: dto.note,
        });
        ctx.notify('schedule.reschedule_requested', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }
}

const watTime = (date: Date) =>
  date.toLocaleTimeString('en-NG', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
  });
