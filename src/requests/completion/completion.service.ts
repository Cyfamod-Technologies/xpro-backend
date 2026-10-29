import { Injectable } from '@nestjs/common';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { FinanceService } from '../../payments/finance.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner } from '../command-runner';
import { openEscalation } from '../escalation-effects';
import { UploadsService } from '../../uploads/uploads.service';
import { ISSUE_ENTITY } from '../../uploads/entity-types';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
// new message: not in spec
const PAYOUT_NOT_SET = 'Set the provider payout before confirming completion.';

@Injectable()
export class CompletionService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly finance: FinanceService,
    private readonly uploads: UploadsService,
  ) {}

  async respond(
    user: RequestUser,
    requestId: string,
    dto: {
      acknowledge: boolean;
      note?: string;
      attachments?: Array<{ id: string }>;
    },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireCustomer(actor);
    return this.runner.run(
      {
        command: 'completion.respond',
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
        // The runner guard checked the owner, that the report awaits the customer and the note on an issue response (04 §6.17).
        if (!dto.acknowledge) {
          const issueNote = (dto.note ?? '').trim();
          const cycle = await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { issueCycles: { increment: 1 }, status: 'blocked' },
            select: { issueCycles: true },
          });
          const issue = await ctx.tx.issue.create({
            data: {
              requestId: ctx.snap.id,
              window: 'completion',
              note: issueNote,
              raisedBy: user.id,
              raisedAt: ctx.now,
              cycle: cycle.issueCycles,
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
          if (
            cycle.issueCycles >
            Number(ctx.settings['completion.maxIssueCycles'] ?? 2)
          ) {
            await ctx.tx.issue.update({
              where: { id: issue.id },
              data: { status: 'disputed' },
            });
            await openEscalation(ctx, {
              to: 'super_admin',
              note: issueNote,
              source: 'system',
            });
          } else {
            // 02 §6.11: the completion issue waits for issue.resolve from the moment it is raised.
            ctx.approvals.open('completion_issue', issue.id);
          }
          ctx.audit('Issue raised at completion', {
            resourceType: 'issue',
            resourceId: issue.id,
            note: issueNote,
          });
          ctx.notify('issue.raised', { requestCode: ctx.snap.number });
          return;
        }
        const days = Number(ctx.settings['completion.defectsWindowDays'] ?? 7);
        const endsAt = new Date(ctx.now.getTime() + days * 86_400_000);
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            status: 'acknowledged',
            acknowledgedAt: ctx.now,
            acknowledgedBy: 'customer',
            acknowledgedNote: dto.note?.trim() || null,
            defectsWindowEndsAt: endsAt,
          },
        });
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        const quote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        if (
          !assignment ||
          quote?.payoutAmount == null ||
          quote.payoutAssignmentId !== assignment.id
        )
          throw conflict(PAYOUT_NOT_SET);
        await this.finance.createPrimary(ctx, {
          requestId: ctx.snap.id,
          assignmentId: assignment.id,
          providerId: assignment.providerId,
          amount: quote.payoutAmount,
          payoutAssignmentId: quote.payoutAssignmentId,
        });
        ctx.timers.stop([
          'T17.reminder24h',
          'T17.reminder48h',
          'T17.autoConfirm',
        ]);
        ctx.timers.start('T21.defectsEnd', endsAt);
        ctx.audit('Completion acknowledged', {
          changes: { defectsWindowEndsAt: endsAt.toISOString() },
        });
        ctx.notify('completion.acknowledged', { requestCode: ctx.snap.number });
      },
    );
  }

  async confirmOnBehalf(
    userId: string,
    requestId: string,
    dto: { note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'issue.resolve');
    return this.runner.run(
      {
        command: 'completion.confirmOnBehalf',
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
        // The runner guard checked that the report awaits the customer and no issue is open.
        const days = Number(ctx.settings['completion.defectsWindowDays'] ?? 7);
        const endsAt = new Date(ctx.now.getTime() + days * 86_400_000);
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            status: 'acknowledged',
            acknowledgedAt: ctx.now,
            acknowledgedBy: 'staff',
            acknowledgedNote: dto.note.trim(),
            defectsWindowEndsAt: endsAt,
          },
        });
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        const quote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        if (
          !assignment ||
          quote?.payoutAmount == null ||
          quote.payoutAssignmentId !== assignment.id
        )
          throw conflict(PAYOUT_NOT_SET);
        await this.finance.createPrimary(ctx, {
          requestId: ctx.snap.id,
          assignmentId: assignment.id,
          providerId: assignment.providerId,
          amount: quote.payoutAmount,
          payoutAssignmentId: quote.payoutAssignmentId,
        });
        ctx.timers.stop([
          'T17.reminder24h',
          'T17.reminder48h',
          'T17.autoConfirm',
        ]);
        ctx.timers.start('T21.defectsEnd', endsAt);
        ctx.audit('Completion confirmed on behalf of customer', {
          note: dto.note,
        });
        ctx.notify('completion.acknowledged', { requestCode: ctx.snap.number });
      },
    );
  }
}
