import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requirePermission } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { NOSHOW_ENTITY } from '../../uploads/entity-types';
import { UploadsService } from '../../uploads/uploads.service';
import { ProvidersService } from '../../providers/providers.service';
import { RequestCommandRunner } from '../command-runner';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
// new message: not in spec
const REVIEW_ALREADY_OPEN =
  'A no-show review is already open for this schedule.';
// new message: not in spec
const ASSIGNMENT_NOT_CURRENT = 'This assignment is no longer current.';
// new message: not in spec
const DECISION_STALE = 'This no-show decision is stale.';
// new message: not in spec
const NOT_CORRECTABLE = 'This no-show cannot be corrected.';

@Injectable()
export class NoShowService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly uploads: UploadsService,
    private readonly providers: ProvidersService,
  ) {}

  async record(
    userId: string,
    requestId: string,
    dto: { scheduleId: string; note: string; evidenceIds?: string[] },
    version: number | undefined,
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
            id: dto.scheduleId,
            requestId: ctx.snap.id,
            status: 'confirmed',
          },
        });
        // The runner guard checked the current schedule (04 §6.16); the body's scheduleId needs the row.
        if (!schedule) throw conflict('This schedule is no longer confirmed.');
        const open = await ctx.tx.noShow.findFirst({
          where: {
            scheduleId: schedule.id,
            status: { in: ['open', 'confirmed'] },
          },
        });
        if (open) throw conflict(REVIEW_ALREADY_OPEN);
        const assignment = await ctx.tx.assignment.findUnique({
          where: { id: schedule.assignmentId },
        });
        if (!assignment) throw conflict(ASSIGNMENT_NOT_CURRENT);
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
        await this.uploads.attach(
          ctx.tx,
          dto.evidenceIds ?? [],
          userId,
          'progress_evidence',
          NOSHOW_ENTITY,
          row.id,
        );
        // 02 §6.11: the item opened at the end of the grace period, or opens now for a staff report.
        ctx.approvals.open('no_show', schedule.id);
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
    version: number | undefined,
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
        input: dto,
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
          throw conflict(DECISION_STALE);
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
        ctx.approvals.close('no_show', row.scheduleId, status);
        if (outcome === 'confirm') {
          const review = await this.providers.recordReliabilityEvent(ctx.tx, {
            providerId: row.providerId,
            kind: 'no_show_confirmed',
            sourceId: row.id,
            requestId: ctx.snap.id,
            occurredAt: ctx.now,
            confirmedBy: userId,
            note: dto.note.trim(),
          });
          // 02 §6.11: two confirmed no-shows in 90 days put the provider in the reliability review.
          if (review === 'review_due')
            ctx.approvals.open('provider_reliability', row.providerId);
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
    version: number | undefined,
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
        input: dto,
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
          throw conflict(NOT_CORRECTABLE);
        await ctx.tx.noShow.update({
          where: { id: row.id },
          data: {
            status: 'voided',
            decisionNote: dto.note.trim(),
            version: { increment: 1 },
          },
        });
        const review = await this.providers.recordReliabilityEvent(ctx.tx, {
          providerId: row.providerId,
          kind: 'no_show_voided',
          sourceId: `${row.id}:voided`,
          requestId: ctx.snap.id,
          occurredAt: ctx.now,
          confirmedBy: userId,
          note: dto.note.trim(),
        });
        if (review === 'cleared')
          ctx.approvals.close(
            'provider_reliability',
            row.providerId,
            'no_show_corrected',
          );
        ctx.audit('Provider no-show corrected', {
          resourceType: 'no_show',
          resourceId: row.id,
          note: dto.note,
        });
      },
    );
  }
}
