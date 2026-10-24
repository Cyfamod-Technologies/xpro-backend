import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import { requirePermission, requireProvider } from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { UploadsService } from '../../uploads/uploads.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import { deriveProgressKind, progressEvidenceSatisfied } from '../domain/progress-rules';

const conflict = (message: string) => new AppError(409, 'STATE_CONFLICT', message);
const invalid = (message: string) => new AppError(422, 'VALIDATION_ERROR', message);

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService, private readonly actors: ActorService, private readonly runner: RequestCommandRunner, private readonly uploads: UploadsService) {}

  async list(user: RequestUser, requestId: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId }, select: { id: true, ownerId: true } });
    if (!request) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
    let where: { requestId: string; state?: 'approved'; assignmentId?: string } = { requestId };
    if (actor.kind === 'customer') {
      if (request.ownerId !== user.id) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      where = { ...where, state: 'approved' };
    } else if (actor.kind === 'provider') {
      const assignment = await this.prisma.assignment.findFirst({ where: { requestId, providerUserId: user.id, status: 'accepted' }, select: { id: true } });
      if (!assignment) throw new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
      where = { ...where, assignmentId: assignment.id };
    } else requirePermission(actor, 'progress.review');
    const rows = await this.prisma.progressUpdate.findMany({ where, orderBy: { createdAt: 'asc' } });
    const uploads = rows.length ? await this.prisma.upload.findMany({ where: { entityType: 'progress_update', entityId: { in: rows.map((row) => row.id) }, purpose: 'progress_evidence', status: 'attached' }, select: { id: true, entityId: true, fileName: true, contentType: true, size: true } }) : [];
    return rows.map((row) => ({ id: row.id, kind: row.kind, target: row.target, note: row.note, state: row.state, createdAt: row.createdAt.toISOString(), reviewNote: row.state === 'pending' && actor.kind !== 'staff' ? null : row.reviewNote, attachments: uploads.filter((upload) => upload.entityId === row.id).map((upload) => ({ id: upload.id, name: upload.fileName, type: upload.contentType, size: upload.size })) }));
  }

  async add(userId: string, requestId: string, dto: { status: 'in_progress' | 'blocked' | 'completion_pending'; note: string; attachments: string[]; issueId?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(userId); requireProvider(actor);
    return this.runner.run({ command: 'progress.add', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const assignment = await ctx.tx.assignment.findFirst({ where: { requestId: ctx.snap.id, providerUserId: userId, status: 'accepted' }, orderBy: { createdAt: 'desc' } });
      if (!assignment) throw conflict('Accept the current assignment before updating this job.');
      if (ctx.snap.status === 'blocked' && ctx.snap.hold) throw conflict('XPro has paused this job. Message XPro Dispatch before continuing.');
      if (['closed', 'cancelled', 'rejected', 'cancelling', 'acknowledged'].includes(ctx.snap.status)) throw conflict('This job is not open for execution updates.');
      const issue = dto.issueId ? await ctx.tx.issue.findFirst({ where: { id: dto.issueId, requestId: ctx.snap.id } }) : await ctx.tx.issue.findFirst({ where: { requestId: ctx.snap.id, status: { in: ['open', 'rework', 'disputed'] } }, orderBy: { cycle: 'desc' } });
      if (issue && ['open', 'disputed'].includes(issue.status)) throw conflict('XPro is resolving the issue reported at completion. You can update the job once it is resolved.');
      const kind = deriveProgressKind({ status: dto.status, requestStatus: ctx.snap.status, issueStatus: issue?.status, issueId: dto.issueId });
      if (!kind) {
        if (dto.status === 'completion_pending') throw conflict('Resume or start work before reporting completion.');
        if (dto.status === 'blocked') throw conflict('Start the job before reporting a blocker.');
        if (ctx.snap.status === 'scheduled') throw conflict('Confirm the schedule before starting work.');
        throw conflict('This job is not open for execution updates.');
      }
      if (kind === 'start') {
        const schedule = await ctx.tx.schedule.findFirst({ where: { requestId: ctx.snap.id, assignmentId: assignment.id, status: 'confirmed' }, orderBy: { proposedAt: 'desc' } });
        if (!schedule) throw conflict('Confirm the schedule before starting work.');
        if (ctx.now.getTime() < schedule.startAt.getTime() - 2 * 60 * 60_000) throw conflict(`You can start this job from ${schedule.startAt.toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })} WAT.`);
      }
      const pending = await ctx.tx.progressUpdate.findMany({ where: { requestId: ctx.snap.id, assignmentId: assignment.id, state: 'pending' }, orderBy: { createdAt: 'asc' } });
      if (pending.length && kind === 'blocker' && pending.every((item) => ['start', 'progress', 'resume', 'rework'].includes(item.kind))) {
        await ctx.tx.progressUpdate.updateMany({ where: { id: { in: pending.map((item) => item.id) } }, data: { state: 'rejected', systemReason: 'replaced_by_blocker', reviewNote: 'Replaced by your blocker report.' } });
      } else if (pending.length) throw conflict('Wait for XPro to review your previous update.');
      const row = await ctx.tx.progressUpdate.create({ data: { requestId: ctx.snap.id, assignmentId: assignment.id, authorId: userId, kind, target: dto.status, note: dto.note.trim(), issueId: issue?.id ?? null } });
      const uploads = await this.uploads.attach(ctx.tx, dto.attachments, userId, 'progress_evidence', 'progress_update', row.id);
      if (kind === 'completion' || kind === 'rework_completion') {
        const prior = await ctx.tx.progressUpdate.findMany({ where: { requestId: ctx.snap.id, assignmentId: assignment.id, state: 'approved' }, select: { id: true } });
        const priorEvidence = prior.length ? await ctx.tx.upload.count({ where: { entityType: 'progress_update', entityId: { in: prior.map((item) => item.id) }, purpose: 'progress_evidence', status: 'attached' } }) : 0;
        if (!progressEvidenceSatisfied({ hasCurrentAttachments: uploads.length > 0, hasApprovedCurrentAssignmentEvidence: priorEvidence > 0 })) throw conflict('Attach work evidence before reporting completion.');
      }
      const hours = kind === 'blocker' ? 1 : 8;
      ctx.timers.start(kind === 'blocker' ? 'T16.review' : 'T15.stale', new Date(ctx.now.getTime() + hours * 60 * 60_000), row.id);
      ctx.audit('Progress update submitted', { resourceType: 'progress_update', resourceId: row.id, changes: { kind } });
      ctx.notify(kind === 'blocker' ? 'progress.blocker_needed' : kind === 'completion' ? 'progress.completion_needed' : 'progress.review_needed', { requestCode: ctx.snap.number });
    });
  }

  async review(userId: string, requestId: string, updateId: string, dto: { approve: boolean; note?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'progress.review');
    if (!dto.approve && !dto.note?.trim()) throw invalid('Explain why the update is not approved.');
    return this.runner.run({ command: 'progress.review', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const update = await ctx.tx.progressUpdate.findFirst({ where: { id: updateId, requestId: ctx.snap.id } });
      if (!update || update.state !== 'pending') throw conflict('This update is no longer awaiting review.');
      const assignment = await ctx.tx.assignment.findFirst({ where: { id: update.assignmentId, requestId: ctx.snap.id, status: 'accepted' } });
      if (!assignment && dto.approve) throw conflict('This update came from a provider who is no longer on the job. Reject it instead.');
      if (dto.approve && assignment) {
        const providerUser = await ctx.tx.user.findUnique({ where: { id: assignment.providerUserId }, select: { status: true } });
        if (providerUser?.status !== 'active') throw conflict('This provider is suspended. Reject the update or replace the provider.');
      }
      if (ctx.snap.hold && dto.approve) throw conflict('XPro has paused this job. Message XPro Dispatch before continuing.');
      if (dto.approve && ['completion', 'rework_completion'].includes(update.kind)) {
        const evidence = await ctx.tx.upload.count({ where: { entityType: 'progress_update', entityId: update.id, purpose: 'progress_evidence', status: 'attached' } });
        if (!evidence) throw conflict('Work evidence is required before completion can be approved.');
      }
      const state = dto.approve ? 'approved' : 'rejected';
      await ctx.tx.progressUpdate.update({ where: { id: update.id }, data: { state, reviewedBy: userId, reviewedAt: ctx.now, reviewNote: dto.note?.trim() || null } });
      ctx.timers.stop(['T15.stale', 'T15.escalate', 'T16.review'], update.id);
      if (dto.approve) {
        if (update.kind === 'start') {
          await ctx.tx.assignment.update({ where: { id: update.assignmentId }, data: { workStarted: true } });
          await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'in_progress' } });
          ctx.timers.stop('T13.noShowCheck'); ctx.timers.start('T15.stale', new Date(ctx.now.getTime() + 3 * 86_400_000)); ctx.timers.start('T15.escalate', new Date(ctx.now.getTime() + 5 * 86_400_000));
          ctx.notify('progress.started', { requestCode: ctx.snap.number });
        } else if (update.kind === 'blocker') {
          await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'blocked' } }); ctx.timers.start('T16.review', new Date(ctx.now.getTime() + 8 * 60 * 60_000));
          ctx.notify('progress.blocker_approved', { requestCode: ctx.snap.number });
        } else if (update.kind === 'resume') {
          await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'in_progress' } }); ctx.timers.stop('T16.review'); ctx.timers.start('T15.stale', new Date(ctx.now.getTime() + 3 * 86_400_000));
          ctx.notify('progress.resumed', { requestCode: ctx.snap.number });
        } else if (update.kind === 'completion' || update.kind === 'rework_completion') {
          if (update.kind === 'rework_completion' && update.issueId) await ctx.tx.issue.update({ where: { id: update.issueId }, data: { status: 'resolved', resolvedBy: userId, resolvedAt: ctx.now, resolvedWith: 'rework', evidenceUpdateIds: { push: update.id } } });
          const hours = Number(ctx.settings['completion.windowHours'] ?? 72); const dueAt = new Date(ctx.now.getTime() + hours * 60 * 60_000);
          await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'completion_pending', reportApprovedAt: ctx.now, confirmDueAt: dueAt } });
          ctx.timers.stop('T15.stale'); ctx.timers.start('T17.reminder24h', new Date(ctx.now.getTime() + 24 * 60 * 60_000)); ctx.timers.start('T17.reminder48h', new Date(ctx.now.getTime() + 48 * 60 * 60_000)); ctx.timers.start('T17.autoConfirm', dueAt);
          ctx.notify('progress.completion_approved', { requestCode: ctx.snap.number });
        } else { ctx.timers.start('T15.stale', new Date(ctx.now.getTime() + 3 * 86_400_000)); ctx.timers.start('T15.escalate', new Date(ctx.now.getTime() + 5 * 86_400_000)); }
      }
      ctx.audit(dto.approve ? 'Progress update approved' : 'Progress update rejected', { resourceType: 'progress_update', resourceId: update.id, note: dto.note, changes: { kind: update.kind } });
    });
  }

  async addOnBehalf(userId: string, requestId: string, dto: { status: 'in_progress' | 'blocked' | 'completion_pending'; note: string; reportedVia: string; attachments: string[]; issueId?: string }, version: number, url: string, key?: string) {
    const actor = await this.actors.resolve(userId); requirePermission(actor, 'progress.review');
    return this.runner.run({ command: 'progress.addOnBehalf', actor, requestRef: requestId, expectedVersion: version, ...(key ? { idempotencyKey: key, idempotencyHash: hashRequest('POST', url, dto) } : {}) }, async (ctx) => {
      const assignment = await ctx.tx.assignment.findFirst({ where: { requestId: ctx.snap.id, status: 'accepted' }, orderBy: { createdAt: 'desc' } });
      if (!assignment) throw conflict('Accept the current assignment before updating this job.');
      const issue = dto.issueId ? await ctx.tx.issue.findFirst({ where: { id: dto.issueId, requestId: ctx.snap.id, status: 'rework' } }) : null;
      const kind = deriveProgressKind({ status: dto.status, requestStatus: ctx.snap.status, issueStatus: issue?.status, issueId: dto.issueId });
      if (!kind) throw conflict('This job is not open for execution updates.');
      if (ctx.snap.hold) throw conflict('XPro has paused this job. Message XPro Dispatch before continuing.');
      const row = await ctx.tx.progressUpdate.create({ data: { requestId: ctx.snap.id, assignmentId: assignment.id, authorId: userId, kind, target: dto.status, note: dto.note.trim(), issueId: issue?.id ?? null, state: 'approved', reviewedBy: userId, reviewedAt: ctx.now, onBehalf: { reportedVia: dto.reportedVia.trim(), recordedBy: userId } } });
      const files = await this.uploads.attach(ctx.tx, dto.attachments, userId, 'progress_evidence', 'progress_update', row.id);
      if ((kind === 'completion' || kind === 'rework_completion') && !progressEvidenceSatisfied({ hasCurrentAttachments: files.length > 0, hasApprovedCurrentAssignmentEvidence: false })) throw conflict('Work evidence is required before completion can be approved.');
      if (kind === 'start') {
        await ctx.tx.assignment.update({ where: { id: assignment.id }, data: { workStarted: true } });
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'in_progress' } });
        ctx.timers.stop('T13.noShowCheck'); ctx.timers.start('T15.stale', new Date(ctx.now.getTime() + 3 * 86_400_000)); ctx.timers.start('T15.escalate', new Date(ctx.now.getTime() + 5 * 86_400_000));
      } else if (kind === 'blocker') {
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'blocked' } }); ctx.timers.start('T16.review', new Date(ctx.now.getTime() + 8 * 60 * 60_000));
      } else if (kind === 'resume') {
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'in_progress' } }); ctx.timers.stop('T16.review'); ctx.timers.start('T15.stale', new Date(ctx.now.getTime() + 3 * 86_400_000)); ctx.timers.start('T15.escalate', new Date(ctx.now.getTime() + 5 * 86_400_000));
      } else if (kind === 'completion' || kind === 'rework_completion') {
        const dueAt = new Date(ctx.now.getTime() + Number(ctx.settings['completion.windowHours'] ?? 72) * 60 * 60_000);
        await ctx.tx.serviceRequest.update({ where: { id: ctx.snap.id }, data: { status: 'completion_pending', reportApprovedAt: ctx.now, confirmDueAt: dueAt } });
        ctx.timers.stop('T15.stale'); ctx.timers.start('T17.reminder24h', new Date(ctx.now.getTime() + 24 * 60 * 60_000)); ctx.timers.start('T17.reminder48h', new Date(ctx.now.getTime() + 48 * 60 * 60_000)); ctx.timers.start('T17.autoConfirm', dueAt);
      }
      ctx.audit('Progress update recorded on behalf of provider', { resourceType: 'progress_update', resourceId: row.id, note: dto.note, changes: { kind, reportedVia: dto.reportedVia } });
      ctx.notify('progress.on_behalf', { requestCode: ctx.snap.number });
    });
  }
}
