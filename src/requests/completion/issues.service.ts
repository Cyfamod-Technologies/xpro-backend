import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { EscalationsService } from '../../approvals/escalations.service';
import { FinanceService } from '../../payments/finance.service';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner, type CommandContext } from '../command-runner';
import { openEscalation } from '../escalation-effects';
import { UploadsService } from '../../uploads/uploads.service';
import { ISSUE_ENTITY } from '../../uploads/entity-types';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
// new message: not in spec
const ISSUE_NOT_AWAITING_REVIEW = 'This issue is no longer awaiting review.';
// new message: not in spec
const ISSUE_NOT_OPEN = 'This issue is no longer open.';

@Injectable()
export class IssuesService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly uploads: UploadsService,
    private readonly finance: FinanceService,
    private readonly escalations: EscalationsService,
  ) {}

  async raise(
    user: RequestUser,
    requestId: string,
    dto: { note: string; attachments?: Array<{ id: string }> },
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
        // The runner guard checked the owner, the defects window and the note (04 §6.17).
        const request = await ctx.tx.serviceRequest.findUniqueOrThrow({
          where: { id: ctx.snap.id },
          select: { issueCycles: true },
        });
        const note = dto.note.trim();
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
        await this.uploads.attach(
          ctx.tx,
          (dto.attachments ?? []).map(({ id }) => id),
          user.id,
          'progress_evidence',
          ISSUE_ENTITY,
          issue.id,
        );
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'blocked', issueCycles: cycle },
        });
        await this.finance.holdForIssue(ctx, ctx.snap.id, issue.id);
        const max = Number(ctx.settings['completion.maxIssueCycles'] ?? 2);
        if (cycle > max) await this.dispute(ctx, issue.id, note);
        // 02 §6.11: the completion issue waits for issue.resolve; a disputed one waits on the super admin escalation instead.
        else ctx.approvals.open('completion_issue', issue.id);
        // The closure guard is no longer met while an issue is open.
        ctx.approvals.close('ready_to_close', ctx.snap.id, 'issue_raised');
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
        // The runner guard checked that an issue awaits review; the path's issueId needs its row.
        const issue = await ctx.tx.issue.findFirst({
          where: { id: issueId, requestId: ctx.snap.id, status: 'open' },
        });
        if (!issue) throw conflict(ISSUE_NOT_AWAITING_REVIEW);
        await ctx.tx.issue.update({
          where: { id: issue.id },
          data: { status: 'rework', acceptedBy: userId, acceptedAt: ctx.now },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'in_progress' },
        });
        ctx.approvals.close('completion_issue', issue.id, 'rework_accepted');
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
        // The runner guard checked the reason, the super admin for a dispute decision and that an issue is in the right state; the path's issueId needs its row.
        const note = dto.note.trim();
        const disputeDecision = dto.outcome === 'dispute_decision';
        const issue = await ctx.tx.issue.findFirst({
          where: {
            id: issueId,
            requestId: ctx.snap.id,
            status: {
              in: disputeDecision ? ['disputed'] : ['open', 'rework'],
            },
          },
        });
        if (!issue) throw conflict(ISSUE_NOT_OPEN);
        if (disputeDecision && dto.requireRework) {
          // Not resolved yet: the resolution fields stay null until the rework is approved.
          await ctx.tx.issue.update({
            where: { id: issue.id },
            data: {
              status: 'rework',
              acceptedBy: userId,
              acceptedAt: ctx.now,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'in_progress' },
          });
          ctx.notify('issue.rework_accepted', { requestCode: ctx.snap.number });
        } else {
          await ctx.tx.issue.update({
            where: { id: issue.id },
            data: {
              status: 'resolved',
              resolvedBy: userId,
              resolvedAt: ctx.now,
              resolvedWith: disputeDecision ? 'dispute_decision' : 'no_rework',
              resolution: note,
            },
          });
          const remaining = await ctx.tx.issue.count({
            where: {
              requestId: ctx.snap.id,
              id: { not: issue.id },
              status: { in: ['open', 'rework', 'disputed'] },
            },
          });
          ctx.notify('issue.resolved', { requestCode: ctx.snap.number });
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
            // The customer reconfirms or reports a new issue (04 §6.17).
            ctx.notify('progress.completion_approved', {
              requestCode: ctx.snap.number,
            });
          }
        }
        ctx.approvals.close('completion_issue', issue.id, 'resolved');
        if (disputeDecision) {
          const stillDisputed = await ctx.tx.issue.count({
            where: {
              requestId: ctx.snap.id,
              id: { not: issue.id },
              status: 'disputed',
            },
          });
          if (!stillDisputed)
            await this.escalations.resolveForDispute(ctx, userId, note);
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
    dto: { note?: string },
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
        if (!issue) throw conflict(ISSUE_NOT_OPEN);
        // The runner guard required a note of 5 or more characters.
        const note = (dto.note ?? '').trim();
        await this.dispute(ctx, issue.id, note, userId);
        ctx.approvals.close('completion_issue', issue.id, 'escalated');
        ctx.audit('Issue escalated', {
          resourceType: 'issue',
          resourceId: issue.id,
          note,
        });
      },
    );
  }

  private async dispute(
    ctx: CommandContext,
    issueId: string,
    note: string,
    userId?: string,
  ) {
    await ctx.tx.issue.update({
      where: { id: issueId },
      data: { status: 'disputed' },
    });
    await openEscalation(ctx, {
      to: 'super_admin',
      note,
      source: 'system',
      raisedBy: userId ?? null,
    });
  }
}
