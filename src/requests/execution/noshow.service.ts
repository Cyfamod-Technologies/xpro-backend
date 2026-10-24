import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requirePermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class NoShowService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async record(
    userId: string,
    requestId: string,
    dto: { scheduleId: string; note: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'dispatch.manage');
    return this.runner.run(
      {
        command: 'noshow.record',
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
        const schedule = await ctx.tx.schedule.findFirst({
          where: {
            id: dto.scheduleId,
            requestId: ctx.snap.id,
            status: 'confirmed',
          },
        });
        if (!schedule || ctx.snap.currentSchedule?.status !== 'confirmed')
          throw conflict('This schedule is no longer confirmed.');
        const open = await ctx.tx.noShow.findFirst({
          where: {
            scheduleId: schedule.id,
            status: { in: ['open', 'confirmed'] },
          },
        });
        if (open)
          throw conflict('A no-show review is already open for this schedule.');
        const assignment = await ctx.tx.assignment.findUnique({
          where: { id: schedule.assignmentId },
        });
        if (!assignment)
          throw conflict('This assignment is no longer current.');
        const row = await ctx.tx.noShow.create({
          data: {
            requestId: ctx.snap.id,
            scheduleId: schedule.id,
            assignmentId: assignment.id,
            providerId: assignment.providerId,
            status: 'open',
            detectedAt: ctx.now,
            reportedBy: userId,
            note: dto.note.trim(),
          },
        });
        ctx.audit('Provider no-show reported', {
          resourceType: 'no_show',
          resourceId: row.id,
          note: dto.note,
        });
        ctx.notify('noshow.under_review', { requestCode: ctx.snap.number });
      },
    );
  }

  async decide(
    userId: string,
    requestId: string,
    noShowId: string,
    outcome: 'confirm' | 'dismiss',
    dto: { note: string; version: number },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'dispatch.manage');
    return this.runner.run(
      {
        command: outcome === 'confirm' ? 'noshow.confirm' : 'noshow.dismiss',
        actor,
        requestRef: requestId,
        expectedVersion: version,
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, { ...dto, outcome }),
            }
          : {}),
      },
      async (ctx) => {
        const row = await ctx.tx.noShow.findFirst({
          where: { id: noShowId, requestId: ctx.snap.id },
        });
        if (!row || row.status !== 'open' || row.version !== dto.version)
          throw conflict('This no-show decision is stale.');
        const status = outcome === 'confirm' ? 'confirmed' : 'dismissed';
        await ctx.tx.noShow.update({
          where: { id: row.id },
          data: {
            status,
            decidedBy: userId,
            decidedAt: ctx.now,
            decisionNote: dto.note.trim(),
            version: { increment: 1 },
          },
        });
        if (outcome === 'confirm') {
          await ctx.tx.providerReliabilityEvent.createMany({
            data: [
              {
                providerId: row.providerId,
                kind: 'no_show_confirmed',
                sourceId: row.id,
                requestId: ctx.snap.id,
                occurredAt: ctx.now,
                confirmedBy: userId,
                note: dto.note.trim(),
              },
            ],
            skipDuplicates: true,
          });
          const since = new Date(ctx.now.getTime() - 90 * 86_400_000);
          const events = await ctx.tx.providerReliabilityEvent.findMany({
            where: {
              providerId: row.providerId,
              kind: { in: ['no_show_confirmed', 'no_show_voided'] },
              occurredAt: { gte: since },
            },
            select: { kind: true, sourceId: true },
          });
          const active = new Set(
            events
              .filter((event) => event.kind === 'no_show_confirmed')
              .map((event) => event.sourceId),
          );
          for (const event of events)
            if (event.kind === 'no_show_voided')
              active.delete(event.sourceId.replace(/:voided$/, ''));
          if (active.size >= 2)
            await ctx.tx.providerProfile.update({
              where: { id: row.providerId },
              data: { reliabilityStatus: 'review_due' },
            });
        }
        ctx.audit(
          outcome === 'confirm'
            ? 'Provider no-show confirmed'
            : 'Provider no-show dismissed',
          { resourceType: 'no_show', resourceId: row.id, note: dto.note },
        );
        ctx.notify(
          outcome === 'confirm' ? 'noshow.confirmed' : 'noshow.dismissed',
          { requestCode: ctx.snap.number },
        );
      },
    );
  }

  async correct(
    userId: string,
    requestId: string,
    noShowId: string,
    dto: { note: string; version: number },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'dispatch.manage');
    return this.runner.run(
      {
        command: 'noshow.correct',
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
        const row = await ctx.tx.noShow.findFirst({
          where: { id: noShowId, requestId: ctx.snap.id },
        });
        if (!row || row.status !== 'confirmed' || row.version !== dto.version)
          throw conflict('This no-show cannot be corrected.');
        await ctx.tx.noShow.update({
          where: { id: row.id },
          data: {
            status: 'voided',
            decisionNote: dto.note.trim(),
            version: { increment: 1 },
          },
        });
        await ctx.tx.providerReliabilityEvent.createMany({
          data: [
            {
              providerId: row.providerId,
              kind: 'no_show_voided',
              sourceId: `${row.id}:voided`,
              requestId: ctx.snap.id,
              occurredAt: ctx.now,
              confirmedBy: userId,
              note: dto.note.trim(),
            },
          ],
          skipDuplicates: true,
        });
        ctx.audit('Provider no-show corrected', {
          resourceType: 'no_show',
          resourceId: row.id,
          note: dto.note,
        });
      },
    );
  }
}
