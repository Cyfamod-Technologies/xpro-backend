import { Injectable } from '@nestjs/common';
import type { RequestEscalation } from '@prisma/client';
import { ActorService } from '../platform/actor/actor.service';
import {
  requireActiveStaff,
  requirePermission,
} from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { hashRequest } from '../platform/idempotency/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/types/request-user';
import {
  RequestCommandRunner,
  type CommandContext,
} from '../requests/command-runner';
import { ESCALATION_MESSAGES } from '../requests/domain/escalation-guards';
import { openEscalation } from '../requests/escalation-effects';
import { resolveRequestId } from '../requests/request-ref';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);

export type EscalationDto = {
  id: string;
  requestId: string;
  to: 'operations' | 'super_admin';
  source: 'staff' | 'system';
  note: string;
  raisedBy: string | null;
  raisedAt: string;
  state: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

/** 02 §4.5: the `Escalation` shape. The columns keep their names (`target`, `resolution`); the API says `to` and `resolutionNote`. */
export function escalationDto(row: RequestEscalation): EscalationDto {
  return {
    id: row.id,
    requestId: row.requestId,
    to: row.target === 'super_admin' ? 'super_admin' : 'operations',
    source: row.source === 'system' ? 'system' : 'staff',
    note: row.note,
    raisedBy: row.raisedBy,
    raisedAt: row.raisedAt.toISOString(),
    state: row.resolvedAt ? 'resolved' : 'open',
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolution,
  };
}

@Injectable()
export class EscalationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async raise(
    user: RequestUser,
    requestId: string,
    dto: { to: 'operations' | 'super_admin'; note: string },
    version: number | undefined,
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
        input: dto,
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, dto),
            }
          : {}),
      },
      async (ctx) => {
        // The runner guard checked the note, an open request and that no escalation to this target is open.
        const id = await openEscalation(ctx, {
          to: dto.to,
          note: dto.note,
          source: 'staff',
          raisedBy: user.id,
        });
        if (!id) throw conflict(ESCALATION_MESSAGES.alreadyOpen(dto.to));
      },
    );
  }

  async resolve(
    user: RequestUser,
    requestId: string,
    escalationId: string,
    dto: { note: string },
    version: number | undefined,
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
        input: { escalationId, note: dto.note },
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, dto),
            }
          : {}),
      },
      async (ctx) => {
        // The runner guard checked the escalation is open, the raiser and super-admin rules and the note.
        const note = dto.note.trim();
        const row = await ctx.tx.requestEscalation.findFirst({
          where: { id: escalationId, requestId: ctx.snap.id, resolvedAt: null },
        });
        if (!row) throw conflict(ESCALATION_MESSAGES.notOpen);
        await ctx.tx.requestEscalation.update({
          where: { id: row.id },
          data: { resolvedBy: user.id, resolvedAt: ctx.now, resolution: note },
        });
        ctx.approvals.close('escalation', row.id, 'resolved');
        ctx.audit('request.escalation_resolved', {
          resourceType: 'request_escalation',
          resourceId: row.id,
          note,
        });
        if (row.raisedBy)
          ctx.notify('escalation.resolved', {
            recipientId: row.raisedBy,
            requestCode: ctx.snap.number,
            note,
          });
      },
    );
  }

  /**
   * A super admin's dispute decision settles the `to: super_admin` escalation
   * the dispute raised (04 §6.17, 02 §6.10): it is resolved with the decision
   * note and its queue item closes, in the decision's own transaction.
   */
  async resolveForDispute(
    ctx: Pick<
      CommandContext,
      'tx' | 'snap' | 'now' | 'audit' | 'approvals' | 'notify'
    >,
    resolvedBy: string,
    note: string,
  ): Promise<number> {
    const open = await ctx.tx.requestEscalation.findMany({
      where: {
        requestId: ctx.snap.id,
        target: 'super_admin',
        resolvedAt: null,
      },
      select: { id: true, raisedBy: true },
    });
    for (const { id, raisedBy } of open) {
      await ctx.tx.requestEscalation.update({
        where: { id },
        data: { resolvedBy, resolvedAt: ctx.now, resolution: note.trim() },
      });
      ctx.approvals.close('escalation', id, 'resolved');
      ctx.audit('request.escalation_resolved', {
        resourceType: 'request_escalation',
        resourceId: id,
        note,
      });
      if (raisedBy)
        ctx.notify('escalation.resolved', {
          recipientId: raisedBy,
          requestCode: ctx.snap.number,
          note: note.trim(),
        });
    }
    return open.length;
  }

  /** Any active staff member can read a request's escalations (02 §4.5, §11.3). */
  async list(user: RequestUser, requestRef: string): Promise<EscalationDto[]> {
    const actor = await this.actors.resolve(user.id);
    requireActiveStaff(actor);
    const requestId = await resolveRequestId(this.prisma, requestRef);
    if (!requestId)
      throw new AppError(
        404,
        'NOT_FOUND',
        'This request is no longer available to your account.',
      );
    const rows = await this.prisma.requestEscalation.findMany({
      where: { requestId },
      orderBy: { raisedAt: 'desc' },
    });
    return rows.map(escalationDto);
  }
}
