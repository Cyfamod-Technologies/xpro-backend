import { Injectable } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { hashRequest } from '../platform/idempotency/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/types/request-user';
import { RequestCommandRunner } from '../requests/command-runner';
import { ApprovalsHooks } from '../requests/approvals.hooks';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

@Injectable()
export class EscalationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly deadlines: ApprovalsHooks,
  ) {}

  async raise(
    user: RequestUser,
    requestId: string,
    dto: { target: 'operations' | 'super_admin'; note: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.escalate');
    return this.runner.run(
      {
        command: 'request.escalate',
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
        if (['closed', 'cancelled', 'rejected'].includes(ctx.snap.status))
          throw conflict('This request is no longer open.');
        const duplicate = await ctx.tx.requestEscalation.findFirst({
          where: {
            requestId: ctx.snap.id,
            target: dto.target,
            resolvedAt: null,
          },
        });
        if (duplicate)
          throw conflict(
            `This request already has an open escalation to ${dto.target}.`,
          );
        const row = await ctx.tx.requestEscalation.create({
          data: {
            requestId: ctx.snap.id,
            target: dto.target,
            source: 'staff',
            note: dto.note.trim(),
            raisedBy: user.id,
            raisedAt: ctx.now,
          },
        });
        await this.deadlines.open(
          ctx.tx,
          'escalation',
          row.id,
          ctx.snap.id,
          ctx.now,
          user.id,
        );
        ctx.audit('Request escalation raised', {
          resourceType: 'request_escalation',
          resourceId: row.id,
          note: dto.note,
        });
      },
    );
  }

  async resolve(
    user: RequestUser,
    requestId: string,
    escalationId: string,
    dto: { note: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.escalation.resolve');
    return this.runner.run(
      {
        command: 'request.escalation.resolve',
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
        const row = await ctx.tx.requestEscalation.findFirst({
          where: { id: escalationId, requestId: ctx.snap.id, resolvedAt: null },
        });
        if (!row) throw conflict('This escalation is no longer open.');
        if (row.target === 'super_admin' && !actor.staff?.isSuperAdmin)
          throw new AppError(
            403,
            'FORBIDDEN',
            'A super admin must resolve this escalation.',
          );
        if (row.raisedBy === user.id && !actor.staff?.isSuperAdmin)
          throw conflict('Someone else must resolve an escalation you raised.');
        await ctx.tx.requestEscalation.update({
          where: { id: row.id },
          data: {
            resolvedBy: user.id,
            resolvedAt: ctx.now,
            resolution: dto.note.trim(),
          },
        });
        await this.deadlines.close(ctx.tx, 'escalation', row.id, ctx.now);
        ctx.audit('Request escalation resolved', {
          resourceType: 'request_escalation',
          resourceId: row.id,
          note: dto.note,
        });
      },
    );
  }

  async list(user: RequestUser, requestId: string) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.escalation.resolve');
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!request)
      throw new AppError(
        404,
        'NOT_FOUND',
        'This request is no longer available to your account.',
      );
    const rows = await this.prisma.requestEscalation.findMany({
      where: { requestId },
      orderBy: { raisedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      target: row.target,
      source: row.source,
      note: row.note,
      raisedBy: row.raisedBy,
      raisedAt: row.raisedAt.toISOString(),
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolution: row.resolution,
    }));
  }
}
