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
import { ApprovalsHooks } from '../approvals.hooks';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const invalid = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);

@Injectable()
export class CompletionService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly finance: FinanceService,
    private readonly approvals: ApprovalsHooks,
  ) {}

  async respond(
    user: RequestUser,
    requestId: string,
    dto: { acknowledge: boolean; note?: string },
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
        if (user.id !== ctx.snap.ownerId)
          throw new AppError(
            404,
            'NOT_FOUND',
            'This request is no longer available to your account.',
          );
        if (
          ctx.snap.status !== 'completion_pending' ||
          ctx.snap.openIssues.length
        )
          throw conflict(
            'Customer acknowledgement is required before final closure.',
          );
        if (!dto.acknowledge) {
          if (!dto.note?.trim()) throw invalid('Explain the unresolved issue.');
          const cycle = await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { issueCycles: { increment: 1 }, status: 'blocked' },
            select: { issueCycles: true },
          });
          const issue = await ctx.tx.issue.create({
            data: {
              requestId: ctx.snap.id,
              window: 'completion',
              note: dto.note.trim(),
              raisedBy: user.id,
              raisedAt: ctx.now,
              cycle: cycle.issueCycles,
              status: 'open',
            },
          });
          if (
            cycle.issueCycles >
            Number(ctx.settings['completion.maxIssueCycles'] ?? 2)
          ) {
            await ctx.tx.issue.update({
              where: { id: issue.id },
              data: { status: 'disputed' },
            });
            const escalation = await ctx.tx.requestEscalation.create({
              data: {
                requestId: ctx.snap.id,
                target: 'super_admin',
                source: 'system',
                note: dto.note.trim(),
                raisedAt: ctx.now,
              },
            });
            await this.approvals.open(
              ctx.tx,
              'escalation',
              escalation.id,
              ctx.snap.id,
              ctx.now,
            );
          }
          ctx.audit('Issue raised at completion', {
            resourceType: 'issue',
            resourceId: issue.id,
            note: dto.note,
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
          throw conflict(
            'Set the provider payout before confirming completion.',
          );
        await this.finance.createPrimary(ctx.tx, {
          requestId: ctx.snap.id,
          assignmentId: assignment.id,
          providerId: assignment.providerId,
          amount: quote.payoutAmount,
          now: ctx.now,
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
        if (
          ctx.snap.status !== 'completion_pending' ||
          ctx.snap.openIssues.length
        )
          throw conflict(
            'Customer acknowledgement is required before final closure.',
          );
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
          throw conflict(
            'Set the provider payout before confirming completion.',
          );
        await this.finance.createPrimary(ctx.tx, {
          requestId: ctx.snap.id,
          assignmentId: assignment.id,
          providerId: assignment.providerId,
          amount: quote.payoutAmount,
          now: ctx.now,
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
