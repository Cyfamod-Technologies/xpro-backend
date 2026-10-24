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
import {
  canClaim,
  canHandoff,
  canReassign,
  canRelease,
} from './domain/ownership-guards';
import type { ActorView } from './domain/snapshot';

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
      async (ctx) => {
        assertGuard(
          canClaim(
            ctx.snap,
            actorView(actor),
            undefined,
            ctx.now,
            ctx.settings,
          ),
        );
        const row = await requestRow(ctx.tx, ctx.snap.id);
        if (
          row.status === 'cancelled' ||
          row.status === 'rejected' ||
          row.status === 'closed'
        )
          throw conflict(
            'Closed, cancelled or rejected requests cannot be claimed.',
          );
        if (row.staffOwnerId !== null)
          throw conflict('This request already has an owner.');
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
    const note = trimmedNote(dto.note, 'Add a note for whoever picks this up.');
    const canReassign = actor.staff.permissions.has('request.reassign');
    return this.run(
      actor,
      'request.release',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      async (ctx) => {
        assertGuard(
          canRelease(
            ctx.snap,
            actorView(actor),
            { note, expectedOwnerId: dto.expectedOwnerId },
            ctx.now,
            ctx.settings,
          ),
        );
        const row = await requestRow(ctx.tx, ctx.snap.id);
        if (!isOpen(row.status)) throw conflict('This request is closed.');
        if (row.staffOwnerId !== dto.expectedOwnerId) throw ownerChanged();
        if (row.staffOwnerId !== user.id && !canReassign)
          throw forbidden(
            'Only the owner or Operations can release this request.',
          );
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
    const note = trimmedNote(dto.note, 'Add a hand-off note.');
    return this.run(
      actor,
      'request.handoff',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      async (ctx) => {
        assertGuard(
          canHandoff(
            ctx.snap,
            actorView(actor),
            { note, toStaffId: dto.toStaffId },
            ctx.now,
            ctx.settings,
          ),
        );
        const row = await requestRow(ctx.tx, ctx.snap.id);
        if (!isOpen(row.status)) throw conflict('This request is closed.');
        if (row.staffOwnerId !== user.id)
          throw forbidden('Only the owner can hand off this request.');
        if (dto.toStaffId === user.id)
          throw conflict('You already own this request.');
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
    const note = trimmedNote(
      dto.note,
      'Add a reason for reassigning this request.',
    );
    return this.run(
      actor,
      'request.reassign',
      user.id,
      ref,
      version,
      originalUrl,
      dto,
      key,
      async (ctx) => {
        assertGuard(
          canReassign(
            ctx.snap,
            actorView(actor),
            {
              note,
              staffId: dto.staffId,
              expectedOwnerId: dto.expectedOwnerId,
            },
            ctx.now,
            ctx.settings,
          ),
        );
        const row = await requestRow(ctx.tx, ctx.snap.id);
        if (!isOpen(row.status)) throw conflict('This request is closed.');
        if (row.staffOwnerId !== dto.expectedOwnerId) throw ownerChanged();
        if (row.staffOwnerId === dto.staffId)
          throw conflict('This staff member already owns the request.');
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

function trimmedNote(value: string, message: string) {
  const note = typeof value === 'string' ? value.trim() : '';
  if (note.length < 5 || note.length > 500)
    throw new AppError(422, 'VALIDATION_ERROR', message);
  return note;
}

function isOpen(status: string) {
  return (OPEN_STATUSES as readonly string[]).includes(status);
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

function actorView(actor: ActorContext): ActorView {
  return {
    kind: actor.kind,
    userId: actor.userId,
    platformRoles: actor.platformRoles,
    permissions: actor.staff?.permissions,
    canOwn: actor.staff?.canOwn,
  };
}

function assertGuard(
  result: ReturnType<typeof canClaim>,
): asserts result is { ok: true } {
  if (result.ok) return;
  throw new AppError(result.status, result.code, result.message);
}
