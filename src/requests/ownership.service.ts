import { Injectable } from '@nestjs/common';
import { Prisma, StaffStatus } from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { canOwnRequests } from '../staff/staff-permissions';
import { RequestCommandRunner, type CommandContext } from './command-runner';
import type {
  RequestHandoffDto,
  RequestReassignDto,
  RequestReleaseDto,
} from './dto/request-ownership.dto';

const OPEN_STATUSES = [
  'submitted',
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
  'cancelling',
] as const;
const OPEN_STATUS_FILTER = { in: [...OPEN_STATUSES] };

@Injectable()
export class OwnershipService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly idempotency: IdempotencyService,
  ) {}

  async claim(
    user: RequestUser,
    ref: string,
    version: number | undefined,
    originalUrl: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.claim');
    if (!actor.staff?.canOwn)
      throw forbidden('Your staff role does not allow this action.');
    return this.run(
      actor,
      'request.claim',
      user.id,
      ref,
      version,
      originalUrl,
      undefined,
      key,
      undefined,
      async (ctx) => {
        const row = await requestRow(ctx.tx, ctx.snap.id);
        const result = await ctx.tx.serviceRequest.updateMany({
          where: {
            id: row.id,
            staffOwnerId: null,
            ownershipVersion: row.ownershipVersion,
            status: OPEN_STATUS_FILTER,
          },
          data: {
            staffOwnerId: user.id,
            claimedAt: ctx.now,
            unclaimedSince: null,
            ownershipVersion: { increment: 1 },
          },
        });
        if (result.count !== 1) throw ownerChanged();
        ctx.audit('request.claimed', {
          changes: {
            before: { staffOwnerId: null },
            after: { staffOwnerId: user.id },
          },
        });
      },
    );
  }

  async release(
    user: RequestUser,
    ref: string,
    dto: RequestReleaseDto,
    version: number | undefined,
    originalUrl: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireStaffActor(actor);
    return this.run(
      actor,
      'request.release',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      { note: dto.note, expectedOwnerId: dto.expectedOwnerId },
      async (ctx) => {
        // The runner guard validated the note after the permission check and before the owner check (02 §6.6).
        const note = dto.note.trim();
        const row = await requestRow(ctx.tx, ctx.snap.id);
        const beforeOwnerId = row.staffOwnerId;
        await this.changeOwner(ctx.tx, row, null, ctx.now);
        await internalNote(ctx.tx, row.id, user.id, `Released: ${note}`);
        ctx.audit('request.released', {
          note,
          changes: {
            before: { staffOwnerId: beforeOwnerId },
            after: { staffOwnerId: null },
          },
        });
        ctx.notify('request.needs_owner', { requestCode: ctx.snap.number });
        if (beforeOwnerId && beforeOwnerId !== user.id)
          ctx.notify('request.owner_released', {
            recipientId: beforeOwnerId,
            requestCode: ctx.snap.number,
            note,
          });
      },
    );
  }

  async handoff(
    user: RequestUser,
    ref: string,
    dto: RequestHandoffDto,
    version: number | undefined,
    originalUrl: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireStaffActor(actor);
    return this.run(
      actor,
      'request.handoff',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      { note: dto.note, toStaffId: dto.toStaffId },
      async (ctx) => {
        const note = dto.note.trim();
        const row = await requestRow(ctx.tx, ctx.snap.id);
        const target = await eligibleTarget(ctx.tx, dto.toStaffId);
        await this.changeOwner(ctx.tx, row, target.userId, ctx.now);
        await internalNote(
          ctx.tx,
          row.id,
          user.id,
          `Handed off to ${target.name}: ${note}`,
        );
        ctx.audit('request.handed_off', {
          note,
          changes: {
            before: { staffOwnerId: user.id },
            after: { staffOwnerId: target.userId },
          },
        });
        ctx.notify('request.handed_to_you', {
          recipientId: target.userId,
          requestCode: ctx.snap.number,
          note,
        });
      },
    );
  }

  async reassign(
    user: RequestUser,
    ref: string,
    dto: RequestReassignDto,
    version: number | undefined,
    originalUrl: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.reassign');
    return this.run(
      actor,
      'request.reassign',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      {
        note: dto.note,
        staffId: dto.staffId,
        expectedOwnerId: dto.expectedOwnerId,
      },
      async (ctx) => {
        const note = dto.note.trim();
        const row = await requestRow(ctx.tx, ctx.snap.id);
        const target = await eligibleTarget(ctx.tx, dto.staffId);
        const previousOwnerId = row.staffOwnerId;
        await this.changeOwner(ctx.tx, row, target.userId, ctx.now);
        await internalNote(
          ctx.tx,
          row.id,
          user.id,
          `Reassigned to ${target.name}: ${note}`,
        );
        ctx.audit('request.reassigned', {
          note,
          changes: {
            before: { staffOwnerId: previousOwnerId },
            after: { staffOwnerId: target.userId },
          },
        });
        if (target.userId !== user.id)
          ctx.notify('request.assigned_to_you', {
            recipientId: target.userId,
            requestCode: ctx.snap.number,
            note,
          });
        if (previousOwnerId && previousOwnerId !== user.id)
          ctx.notify('request.owner_reassigned', {
            recipientId: previousOwnerId,
            requestCode: ctx.snap.number,
            note,
          });
      },
    );
  }

  private async run(
    actor: ActorContext,
    command: string,
    userId: string,
    ref: string,
    version: number | undefined,
    originalUrl: string,
    body: unknown,
    key: string | undefined,
    input: unknown,
    fn: (context: CommandContext) => Promise<void>,
  ) {
    const hash =
      body === undefined
        ? this.idempotency.hashRequest('POST', originalUrl, {})
        : this.idempotency.hashRequest('POST', originalUrl, body);
    return this.runner.run(
      {
        command,
        actor,
        requestRef: ref,
        input,
        ...(version !== undefined ? { expectedVersion: version } : {}),
        ...(key ? { idempotencyKey: key, idempotencyHash: hash } : {}),
      },
      fn,
    );
  }

  private async changeOwner(
    tx: Prisma.TransactionClient,
    row: {
      id: string;
      staffOwnerId: string | null;
      ownershipVersion: number;
      status: string;
    },
    staffOwnerId: string | null,
    now: Date,
  ) {
    const result = await tx.serviceRequest.updateMany({
      where: {
        id: row.id,
        staffOwnerId: row.staffOwnerId,
        ownershipVersion: row.ownershipVersion,
        status: OPEN_STATUS_FILTER,
      },
      data: {
        staffOwnerId,
        claimedAt: staffOwnerId ? now : null,
        unclaimedSince: staffOwnerId ? null : now,
        ownershipVersion: { increment: 1 },
      },
    });
    if (result.count !== 1) throw ownerChanged();
  }
}

async function requestRow(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.serviceRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      staffOwnerId: true,
      ownershipVersion: true,
    },
  });
  if (!row)
    throw new AppError(
      404,
      'NOT_FOUND',
      'This request is no longer available to your account.',
    );
  return row;
}

async function eligibleTarget(tx: Prisma.TransactionClient, userId: string) {
  const member = await tx.staffMember.findFirst({
    where: {
      userId,
      status: 'active',
      user: { status: 'active', platformRoles: { some: { role: 'staff' } } },
    },
    select: {
      userId: true,
      roles: { select: { role: true } },
      user: {
        select: { firstName: true, lastName: true, name: true, email: true },
      },
    },
  });
  if (
    !member ||
    !canOwnRequests(
      StaffStatus.active,
      member.roles.map(({ role }) => role),
    )
  )
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Choose an active staff member who can own requests.',
    );
  const name =
    [member.user.firstName, member.user.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    member.user.name ||
    member.user.email;
  return { userId: member.userId, name };
}

async function internalNote(
  tx: Prisma.TransactionClient,
  requestId: string,
  authorId: string,
  text: string,
) {
  await tx.requestMessage.create({
    data: {
      requestId,
      channel: 'internal',
      authorId,
      authorRole: 'staff',
      text,
    },
  });
}

function requireStaffActor(
  actor: ActorContext,
): asserts actor is ActorContext & {
  staff: NonNullable<ActorContext['staff']>;
} {
  if (actor.kind !== 'staff' || actor.staff?.status !== 'active')
    throw forbidden('This action is not available for your account type.');
}

function conflict(message: string) {
  return new AppError(409, 'STATE_CONFLICT', message);
}
function ownerChanged() {
  return conflict("This request's owner has changed. Refresh and retry.");
}
function forbidden(message: string) {
  return new AppError(403, 'FORBIDDEN', message);
}
