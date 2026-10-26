import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requirePermission,
  requireProvider,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PROGRESS_UPDATE_ENTITY } from '../../uploads/entity-types';
import { UploadsService } from '../../uploads/uploads.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner, type CommandContext } from '../command-runner';
import {
  checkProgressAdd,
  deriveProgressKind,
  PROGRESS_STALE_MESSAGE,
  type ProgressAddCheck,
  type ProgressInputStatus,
} from '../domain/progress-rules';
import { resolveRequestId } from '../request-ref';
import {
  applyApprovedEffects,
  hasApprovedAssignmentEvidence,
  hasAttachedEvidence,
  reviewItemKind,
} from './progress-effects';

type AttachmentRef = { id: string };
type AddInput = {
  status: ProgressInputStatus;
  note: string;
  attachments?: AttachmentRef[];
  issueId?: string;
};

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly uploads: UploadsService,
  ) {}

  async list(user: RequestUser, requestRef: string) {
    const actor = await this.actors.resolve(user.id);
    const requestId = await resolveRequestId(this.prisma, requestRef);
    const request = requestId
      ? await this.prisma.serviceRequest.findUnique({
          where: { id: requestId },
          select: { id: true, ownerId: true },
        })
      : null;
    if (!request || !requestId)
      throw new AppError(
        404,
        'NOT_FOUND',
        'This request is no longer available to your account.',
      );
    let where: {
      requestId: string;
      state?: 'approved';
      assignmentId?: string;
    } = { requestId };
    if (actor.kind === 'customer') {
      if (request.ownerId !== user.id)
        throw new AppError(
          404,
          'NOT_FOUND',
          'This request is no longer available to your account.',
        );
      where = { ...where, state: 'approved' };
    } else if (actor.kind === 'provider') {
      const assignment = await this.prisma.assignment.findFirst({
        where: { requestId, providerUserId: user.id, status: 'accepted' },
        select: { id: true },
      });
      if (!assignment)
        throw new AppError(
          404,
          'NOT_FOUND',
          'This request is no longer available to your account.',
        );
      where = { ...where, assignmentId: assignment.id };
    } else requirePermission(actor, 'progress.review');
    const rows = await this.prisma.progressUpdate.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    const uploads = rows.length
      ? await this.prisma.upload.findMany({
          where: {
            entityType: PROGRESS_UPDATE_ENTITY,
            entityId: { in: rows.map((row) => row.id) },
            purpose: 'progress_evidence',
            status: 'attached',
          },
          select: {
            id: true,
            entityId: true,
            fileName: true,
            contentType: true,
            size: true,
          },
        })
      : [];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      target: row.target,
      note: row.note,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      // Review text is staff-to-provider; the customer allow-list leaves it out (Plan A.2 #6).
      ...(actor.kind === 'customer' ? {} : { reviewNote: row.reviewNote }),
      attachments: uploads
        .filter((upload) => upload.entityId === row.id)
        .map((upload) => ({
          id: upload.id,
          name: upload.fileName,
          type: upload.contentType,
          size: upload.size,
        })),
    }));
  }

  async add(
    userId: string,
    requestId: string,
    dto: AddInput,
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requireProvider(actor);
    return this.runner.run(
      {
        command: 'progress.add',
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
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            requestId: ctx.snap.id,
            providerUserId: userId,
            status: 'accepted',
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const check = await this.checkAdd(ctx, assignment?.id ?? null, dto, {
          staffOverride: false,
        });
        if (check.replacesPending) {
          const replaced = await ctx.tx.progressUpdate.findMany({
            where: {
              requestId: ctx.snap.id,
              assignmentId: assignment!.id,
              state: 'pending',
            },
            select: { id: true, kind: true },
          });
          await ctx.tx.progressUpdate.updateMany({
            where: {
              id: { in: replaced.map(({ id }) => id) },
              state: 'pending',
            },
            data: {
              state: 'rejected',
              systemReason: 'replaced_by_blocker',
              reviewNote: 'Replaced by your blocker report.',
            },
          });
          for (const item of replaced)
            ctx.approvals.close(
              reviewItemKind(item.kind),
              item.id,
              'replaced_by_blocker',
            );
        }
        const { kind } = check;
        const row = await ctx.tx.progressUpdate.create({
          data: {
            requestId: ctx.snap.id,
            assignmentId: assignment!.id,
            authorId: userId,
            kind,
            target: dto.status,
            note: dto.note.trim(),
            issueId: check.issueId,
          },
        });
        await this.uploads.attach(
          ctx.tx,
          attachmentIds(dto),
          userId,
          'progress_evidence',
          PROGRESS_UPDATE_ENTITY,
          row.id,
        );
        // 02 §6.11: the update waits for progress.review as a queue item (8 h routine, 1 h blocker, 4 h completion), not as a stale-job timer.
        ctx.approvals.open(reviewItemKind(kind), row.id);
        ctx.approvals.close('progress', ctx.snap.id, 'update_submitted');
        ctx.audit('Progress update submitted', {
          resourceType: 'progress_update',
          resourceId: row.id,
          changes: { kind },
        });
        ctx.notify(
          kind === 'blocker'
            ? 'progress.blocker_needed'
            : kind === 'completion'
              ? 'progress.completion_needed'
              : 'progress.review_needed',
          { requestCode: ctx.snap.number },
        );
      },
    );
  }

  async review(
    userId: string,
    requestId: string,
    updateId: string,
    dto: { approve: boolean; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'progress.review');
    return this.runner.run(
      {
        command: 'progress.review',
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
        const update = await ctx.tx.progressUpdate.findFirst({
          where: { id: updateId, requestId: ctx.snap.id },
        });
        if (!update || update.state !== 'pending')
          throw conflict('This update is no longer awaiting review.');
        if (dto.approve) await this.assertApprovable(ctx, update);
        await ctx.tx.progressUpdate.update({
          where: { id: update.id },
          data: {
            state: dto.approve ? 'approved' : 'rejected',
            reviewedBy: userId,
            reviewedAt: ctx.now,
            reviewNote: dto.note?.trim() || null,
          },
        });
        ctx.approvals.close(
          reviewItemKind(update.kind),
          update.id,
          dto.approve ? 'approved' : 'rejected',
        );
        if (dto.approve) await applyApprovedEffects(ctx, update, userId);
        ctx.audit(
          dto.approve ? 'Progress update approved' : 'Progress update rejected',
          {
            resourceType: 'progress_update',
            resourceId: update.id,
            note: dto.note,
            changes: { kind: update.kind },
          },
        );
      },
    );
  }

  async addOnBehalf(
    userId: string,
    requestId: string,
    dto: AddInput & { reportedVia: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'progress.review');
    return this.runner.run(
      {
        command: 'progress.addOnBehalf',
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
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const check = await this.checkAdd(ctx, assignment?.id ?? null, dto, {
          staffOverride: true,
        });
        const row = await ctx.tx.progressUpdate.create({
          data: {
            requestId: ctx.snap.id,
            assignmentId: assignment!.id,
            authorId: userId,
            kind: check.kind,
            target: dto.status,
            note: dto.note.trim(),
            issueId: check.issueId,
            state: 'approved',
            reviewedBy: userId,
            reviewedAt: ctx.now,
            onBehalf: {
              staffId: userId,
              note: dto.note.trim(),
              reportedVia: dto.reportedVia.trim(),
            },
          },
        });
        await this.uploads.attach(
          ctx.tx,
          attachmentIds(dto),
          userId,
          'progress_evidence',
          PROGRESS_UPDATE_ENTITY,
          row.id,
        );
        await applyApprovedEffects(ctx, row, userId);
        ctx.audit('Progress update recorded on behalf of provider', {
          resourceType: 'progress_update',
          resourceId: row.id,
          note: dto.note,
          changes: { kind: check.kind, reportedVia: dto.reportedVia },
        });
        ctx.notify('progress.on_behalf', { requestCode: ctx.snap.number });
      },
    );
  }

  /** Loads the rows the 04 §6.14 add table reads and runs it; the guard already ran the snapshot rows. */
  private async checkAdd(
    ctx: CommandContext,
    assignmentId: string | null,
    dto: AddInput,
    options: { staffOverride: boolean },
  ): Promise<Extract<ProgressAddCheck, { ok: true }>> {
    const schedule = assignmentId
      ? await ctx.tx.schedule.findFirst({
          where: {
            requestId: ctx.snap.id,
            assignmentId,
            status: 'confirmed',
          },
          orderBy: { proposedAt: 'desc' },
          select: { startAt: true },
        })
      : null;
    const issues = await ctx.tx.issue.findMany({
      where: {
        requestId: ctx.snap.id,
        status: { in: ['open', 'rework', 'disputed'] },
      },
      select: { id: true, status: true },
    });
    const pending = assignmentId
      ? await ctx.tx.progressUpdate.findMany({
          where: {
            requestId: ctx.snap.id,
            assignmentId,
            state: 'pending',
          },
          select: { kind: true },
        })
      : [];
    const approvedEvidence =
      assignmentId && dto.status === 'completion_pending'
        ? await hasApprovedAssignmentEvidence(ctx.tx, ctx.snap.id, assignmentId)
        : false;
    const result = checkProgressAdd({
      status: dto.status,
      note: dto.note,
      issueId: dto.issueId,
      requestStatus: ctx.snap.status,
      assignmentAccepted: assignmentId !== null,
      confirmedStartAt: schedule?.startAt ?? null,
      onHold: !!ctx.snap.hold,
      unresolvedIssues: issues,
      hasCurrentAttachments: attachmentIds(dto).length > 0,
      hasApprovedCurrentAssignmentEvidence: approvedEvidence,
      pendingKinds: pending.map(({ kind }) => kind),
      now: ctx.now,
      staffOverride: options.staffOverride,
    });
    if (!result.ok)
      throw new AppError(result.status, result.code, result.message);
    return result;
  }

  /** 04 §6.14 review table, approve rows 3 to 6 (the runner guard checked the rest). */
  private async assertApprovable(
    ctx: CommandContext,
    update: {
      id: string;
      kind: string;
      target: ProgressInputStatus;
      assignmentId: string;
      issueId: string | null;
    },
  ) {
    const assignment = await ctx.tx.assignment.findFirst({
      where: {
        id: update.assignmentId,
        requestId: ctx.snap.id,
        status: 'accepted',
      },
    });
    if (!assignment)
      throw conflict(
        'This update came from a provider who is no longer on the job. Reject it instead.',
      );
    const linked = update.issueId
      ? await ctx.tx.issue.findFirst({
          where: { id: update.issueId, requestId: ctx.snap.id },
          select: { status: true },
        })
      : await ctx.tx.issue.findFirst({
          where: { requestId: ctx.snap.id, status: 'rework' },
          select: { status: true },
        });
    const currentKind = deriveProgressKind({
      status: update.target,
      requestStatus: ctx.snap.status,
      issueStatus: linked?.status,
      issueId: update.issueId ?? undefined,
    });
    if (currentKind !== update.kind) throw conflict(PROGRESS_STALE_MESSAGE);
    if (update.kind === 'completion' || update.kind === 'rework_completion') {
      const satisfied =
        (await hasAttachedEvidence(ctx.tx, [update.id])) ||
        (await hasApprovedAssignmentEvidence(
          ctx.tx,
          ctx.snap.id,
          update.assignmentId,
        ));
      if (!satisfied)
        throw conflict(
          'Work evidence is required before completion can be approved.',
        );
    }
    const providerUser = await ctx.tx.user.findUnique({
      where: { id: assignment.providerUserId },
      select: { status: true },
    });
    if (providerUser?.status !== 'active')
      throw conflict(
        'This provider is suspended. Reject the update or replace the provider.',
      );
  }
}

const attachmentIds = (dto: { attachments?: AttachmentRef[] }) =>
  (dto.attachments ?? []).map(({ id }) => id);
