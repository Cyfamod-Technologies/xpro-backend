import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import { ApprovalsHooks } from '../approvals.hooks';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const invalid = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);

@Injectable()
export class IssuesService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly approvals: ApprovalsHooks,
  ) {}

  async raise(
    user: RequestUser,
    requestId: string,
    dto: { note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireCustomer(actor);
    return this.runner.run(
      {
        command: 'issue.raise',
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
        if (user.id !== ctx.snap.ownerId)
          throw new AppError(
            404,
            'NOT_FOUND',
            'This request is no longer available to your account.',
          );
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
          select: {
            status: true,
            defectsWindowEndsAt: true,
            issueCycles: true,
          },
        });
        if (
          request?.status !== 'acknowledged' ||
          !request.defectsWindowEndsAt ||
          ctx.now >= request.defectsWindowEndsAt
        )
          throw conflict('The defects window has ended.');
        const note = dto.note.trim();
        if (!note) throw invalid('Explain the issue.');
        const cycle = request.issueCycles + 1;
        const issue = await ctx.tx.issue.create({
          data: {
            requestId: ctx.snap.id,
            window: 'defects',
            note,
            raisedBy: user.id,
            raisedAt: ctx.now,
            cycle,
            status: 'open',
          },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'blocked', issueCycles: cycle },
        });
        await ctx.tx.payout.updateMany({
          where: {
            requestId: ctx.snap.id,
            status: {
              in: ['pending_approval', 'awaiting_second_approval', 'approved'],
            },
          },
          data: { status: 'on_hold', holdReason: 'Open customer issue' },
        });
        const max = Number(ctx.settings['completion.maxIssueCycles'] ?? 2);
        if (cycle > max)
          await this.dispute(
            ctx.tx,
            issue.id,
            ctx.snap.id,
            ctx.snap.number,
            ctx.now,
            note,
          );
        ctx.audit('Issue raised during defects window', {
          resourceType: 'issue',
          resourceId: issue.id,
          note,
        });
        ctx.notify('issue.raised', { requestCode: ctx.snap.number });
      },
    );
  }

  async accept(
    userId: string,
    requestId: string,
    issueId: string,
    dto: { note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'issue.resolve');
    return this.runner.run(
      {
        command: 'issue.accept',
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
        const issue = await ctx.tx.issue.findFirst({
          where: { id: issueId, requestId: ctx.snap.id, status: 'open' },
        });
        if (!issue) throw conflict('This issue is no longer awaiting review.');
        await ctx.tx.issue.update({
          where: { id: issue.id },
          data: { status: 'rework', acceptedBy: userId, acceptedAt: ctx.now },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'in_progress' },
        });
        ctx.audit('Issue accepted for rework', {
          resourceType: 'issue',
          resourceId: issue.id,
          note: dto.note,
        });
        ctx.notify('issue.rework_accepted', { requestCode: ctx.snap.number });
      },
    );
  }

  async resolve(
    userId: string,
    requestId: string,
    issueId: string,
    dto: {
      outcome: 'no_rework' | 'dispute_decision';
      note: string;
      requireRework?: boolean;
    },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'issue.resolve');
    return this.runner.run(
      {
        command: 'issue.resolve',
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
        if (!dto.note.trim())
          throw invalid('Add a reason for this issue decision.');
        if (dto.outcome === 'dispute_decision' && !actor.staff?.isSuperAdmin)
          throw new AppError(
            403,
            'FORBIDDEN',
            'A super admin must decide this dispute.',
          );
        const issue = await ctx.tx.issue.findFirst({
          where: {
            id: issueId,
            requestId: ctx.snap.id,
            status: {
              in:
                dto.outcome === 'dispute_decision'
                  ? ['disputed']
                  : ['open', 'rework'],
            },
          },
        });
        if (!issue) throw conflict('This issue is no longer open.');
        if (dto.outcome === 'dispute_decision' && dto.requireRework) {
          await ctx.tx.issue.update({
            where: { id: issue.id },
            data: {
              status: 'rework',
              resolvedBy: userId,
              resolvedAt: ctx.now,
              resolvedWith: 'dispute_decision',
              resolution: dto.note.trim(),
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'in_progress' },
          });
        } else {
          await ctx.tx.issue.update({
            where: { id: issue.id },
            data: {
              status: 'resolved',
              resolvedBy: userId,
              resolvedAt: ctx.now,
              resolvedWith:
                dto.outcome === 'no_rework' ? 'no_rework' : 'dispute_decision',
              resolution: dto.note.trim(),
            },
          });
          const remaining = await ctx.tx.issue.count({
            where: {
              requestId: ctx.snap.id,
              id: { not: issue.id },
              status: { in: ['open', 'rework', 'disputed'] },
            },
          });
          if (!remaining) {
            const dueAt = new Date(
              ctx.now.getTime() +
                Number(ctx.settings['completion.windowHours'] ?? 72) *
                  60 *
                  60_000,
            );
            await ctx.tx.serviceRequest.update({
              where: { id: ctx.snap.id },
              data: {
                status: 'completion_pending',
                reportApprovedAt: ctx.now,
                confirmDueAt: dueAt,
              },
            });
            ctx.timers.start(
              'T17.reminder24h',
              new Date(ctx.now.getTime() + 24 * 60 * 60_000),
            );
            ctx.timers.start(
              'T17.reminder48h',
              new Date(ctx.now.getTime() + 48 * 60 * 60_000),
            );
            ctx.timers.start('T17.autoConfirm', dueAt);
          }
        }
        ctx.audit('Issue resolved', {
          resourceType: 'issue',
          resourceId: issue.id,
          note: dto.note,
          changes: {
            outcome: dto.outcome,
            requireRework: dto.requireRework ?? false,
          },
        });
      },
    );
  }

  async escalate(
    userId: string,
    requestId: string,
    issueId: string,
    dto: { note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'issue.resolve');
    return this.runner.run(
      {
        command: 'issue.escalate',
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
        const issue = await ctx.tx.issue.findFirst({
          where: {
            id: issueId,
            requestId: ctx.snap.id,
            status: { in: ['open', 'rework', 'disputed'] },
          },
        });
        if (!issue) throw conflict('This issue is no longer open.');
        await this.dispute(
          ctx.tx,
          issue.id,
          ctx.snap.id,
          ctx.snap.number,
          ctx.now,
          dto.note.trim(),
          userId,
        );
        ctx.audit('Issue escalated', {
          resourceType: 'issue',
          resourceId: issue.id,
          note: dto.note,
        });
      },
    );
  }

  private async dispute(
    tx: Parameters<ApprovalsHooks['open']>[0],
    issueId: string,
    requestId: string,
    requestCode: string,
    now: Date,
    note: string,
    userId?: string,
  ) {
    await tx.issue.update({
      where: { id: issueId },
      data: { status: 'disputed' },
    });
    const escalation = await tx.requestEscalation.findFirst({
      where: { requestId, target: 'super_admin', resolvedAt: null },
    });
    if (!escalation) {
      const row = await tx.requestEscalation.create({
        data: {
          requestId,
          target: 'super_admin',
          source: 'system',
          note,
          raisedBy: userId ?? null,
          raisedAt: now,
        },
      });
      await this.approvals.open(
        tx,
        'escalation',
        row.id,
        requestId,
        now,
        userId,
      );
    }
    void requestCode;
  }
}
