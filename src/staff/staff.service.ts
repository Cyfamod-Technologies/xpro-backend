import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountStatus,
  AppRole,
  AppSurface,
  AuthTokenPurpose,
  PlatformRole,
  Prisma,
  RoleAddedVia,
  StaffInviteState,
  StaffRole,
  StaffStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { generateRawToken, hashToken } from '../common/utils/token.util';
import { paginationArgs, toPaginatedResult } from '../common/utils/paginate';
import { RequestContextService } from '../common/request-context/request-context.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActorService } from '../platform/actor/actor.service';
import {
  requireActiveStaff,
  requireAnyPermission,
  requirePermission,
} from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { requestFlowFrom } from '../common/utils/request-flow';
import { PrismaService } from '../prisma/prisma.service';
import { SessionStore } from '../redis/session-store.service';
import { RedisAuthService } from '../auth/redis-auth.service';
import { matchingTotpStep } from '../auth/totp.util';
import {
  canOwnRequests,
  permissionsForRoles,
  StaffPermission,
} from './staff-permissions';
import {
  ChangeStaffRolesDto,
  DeactivateStaffDto,
  InviteStaffDto,
  ListStaffQueryDto,
  RenameStaffDto,
  ReactivateStaffDto,
  ResetStaffMfaDto,
  SetStaffLeaveDto,
  StaffConflictDeclarationDto,
  StaffHistoryQueryDto,
  StaffReasonDto,
  SuspendStaffDto,
} from './dto/staff.dto';
import {
  isOnLeave,
  memberName,
  OPEN_REQUEST_FILTER,
  StaffHandoverService,
  watToday,
  type MovedRequest,
} from './staff-handover.service';
import { parseDateOnly, validateLeaveWindow } from './staff-leave';

const FORMER: StaffStatus[] = [StaffStatus.deactivated, StaffStatus.revoked];
const CURRENT: StaffStatus[] = [
  StaffStatus.invited,
  StaffStatus.active,
  StaffStatus.suspended,
];
const INVITES_PER_ACTOR_PER_DAY = 20;
const STALE_MESSAGE =
  'This staff member was changed by someone else. Reload and try again.';

const staffInclude = {
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      name: true,
      lastLoginAt: true,
      mfaEnrolledAt: true,
    },
  },
  roles: { select: { role: true } },
} satisfies Prisma.StaffMemberInclude;

type StaffRow = Prisma.StaffMemberGetPayload<{ include: typeof staffInclude }>;

type NamedRef = { id: string; name: string } | null;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogsService,
    private readonly sessions: SessionStore,
    private readonly redisAuth: RedisAuthService,
    private readonly requestContext: RequestContextService,
    private readonly actors: ActorService,
    private readonly handover: StaffHandoverService,
  ) {}

  async list(actorId: string, query: ListStaffQueryDto) {
    await this.requirePermission(actorId, 'staff.manage');
    const search = query.q?.trim();
    const where: Prisma.StaffMemberWhereInput = {
      ...(query.status
        ? { status: query.status }
        : query.group
          ? { status: { in: query.group === 'former' ? FORMER : CURRENT } }
          : {}),
      ...(query.role ? { roles: { some: { role: query.role } } } : {}),
      ...(search
        ? {
            user: {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const { skip, take } = paginationArgs(query.page, query.limit);
    const [members, total] = await this.prisma.$transaction([
      this.prisma.staffMember.findMany({
        where,
        include: staffInclude,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.staffMember.count({ where }),
    ]);
    return toPaginatedResult(
      await this.projectMany(members),
      total,
      query.page,
      query.limit,
    );
  }

  /** Counts for the list header: statuses, expired invitations and active super admins. */
  async summary(actorId: string) {
    await this.requirePermission(actorId, 'staff.manage');
    const now = new Date();
    const byStatus = await this.prisma.staffMember.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const [invitedExpired, activeSuperAdmins] = await this.prisma.$transaction([
      this.prisma.staffMember.count({
        where: {
          status: StaffStatus.invited,
          invites: {
            some: { state: StaffInviteState.pending, expiresAt: { lte: now } },
          },
        },
      }),
      this.prisma.staffMemberRole.count({
        where: {
          role: StaffRole.super_admin,
          staffMember: { status: StaffStatus.active },
        },
      }),
    ]);
    const count = (status: StaffStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    return {
      active: count(StaffStatus.active),
      invited: count(StaffStatus.invited),
      invitedExpired,
      suspended: count(StaffStatus.suspended),
      former: count(StaffStatus.deactivated) + count(StaffStatus.revoked),
      activeSuperAdmins,
    };
  }

  async myPermissions(actorId: string) {
    const actor = await this.actors.resolve(actorId);
    requireActiveStaff(actor);
    return {
      permissions: [...actor.staff.permissions],
      canOwnRequests: actor.staff.canOwn,
      permVersion: actor.staff.permVersion,
    };
  }

  async get(actorId: string, staffId: string) {
    await this.requirePermission(actorId, 'staff.manage');
    return this.load(staffId);
  }

  /** Members who can take over requests, with their workload (successor and delegate pickers). */
  async owners(actorId: string, excludeId?: string) {
    const actor = await this.actors.resolve(actorId);
    if (requestFlowFrom() === 'v1') requirePermission(actor, 'staff.manage');
    else requireAnyPermission(actor, ['staff.manage', 'request.reassign']);
    const members = await this.prisma.staffMember.findMany({
      where: {
        status: StaffStatus.active,
        ...(excludeId ? { userId: { not: excludeId } } : {}),
        user: { status: 'active' },
      },
      include: staffInclude,
      orderBy: { createdAt: 'asc' },
    });
    const eligible = members.filter(
      (member) =>
        !member.roles.some(({ role }) => role === StaffRole.super_admin) &&
        canOwnRequests(
          member.status,
          member.roles.map(({ role }) => role),
        ),
    );
    if (requestFlowFrom() === 'v1') {
      const workloads = await this.prisma.serviceRequest.groupBy({
        by: ['staffOwnerId'],
        where: {
          workflowMode: 'v1',
          status: 'submitted',
          staffOwnerId: { in: eligible.map((member) => member.userId) },
        },
        _count: { _all: true },
      });
      const workloadByOwner = new Map(
        workloads.map((item) => [item.staffOwnerId, item._count._all]),
      );
      return eligible.map((member) => ({
        id: member.userId,
        name: memberName(member.user),
        email: member.user.email,
        roles: member.roles.map(({ role }) => role),
        openRequests: workloadByOwner.get(member.userId) ?? 0,
      }));
    }
    const workload = await this.workload(
      eligible.map((member) => member.userId),
    );
    const today = watToday();
    return eligible.map((member) => ({
      id: member.userId,
      name: memberName(member.user),
      roles: member.roles.map(({ role }) => role),
      onLeave: isOnLeave(member, today),
      leaveTo: member.leaveTo ? dateOnly(member.leaveTo) : null,
      workload: workload.get(member.userId) ?? {
        openOwned: 0,
        overdueOwned: 0,
      },
    }));
  }

  async history(actorId: string, staffId: string, query: StaffHistoryQueryDto) {
    await this.requirePermission(actorId, 'staff.manage');
    const where = { entityType: 'staff', entityId: staffId };
    const { skip, take } = paginationArgs(query.page, query.limit);
    const [logs, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          actor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPaginatedResult(
      logs.map((log) => ({
        id: log.id,
        action: log.action,
        createdAt: log.createdAt,
        actor: log.actor
          ? { id: log.actor.id, name: memberName(log.actor) }
          : null,
        metadata: log.metadata ?? null,
      })),
      total,
      query.page,
      query.limit,
    );
  }

  async invite(actorId: string, dto: InviteStaffDto, reauthToken?: string) {
    await this.requirePermission(actorId, 'staff.manage');
    this.validateRoles(dto.roles);
    if (dto.roles.includes(StaffRole.super_admin))
      await this.requireStepUp(actorId, reauthToken);
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    const previous = existing
      ? await this.prisma.staffMember.findUnique({
          where: { userId: existing.id },
          select: { status: true },
        })
      : null;
    if (previous && !FORMER.includes(previous.status))
      throw new ConflictException(
        'A staff member with this email already exists.',
      );
    if (existing && !previous)
      throw new ConflictException(
        'This email already belongs to a customer or provider account.',
      );
    const sentToday = await this.prisma.staffInvite.count({
      where: {
        invitedBy: actorId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (sentToday >= INVITES_PER_ACTOR_PER_DAY)
      throw new AppError(
        429,
        'RATE_LIMITED',
        "You've sent the maximum number of invitations for today. Try again tomorrow.",
      );
    const token = generateRawToken();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const userId = await this.prisma.$transaction(async (tx) => {
      let id: string;
      if (existing && previous) {
        // Rehire or re-invite: the same account starts a new employment period with nothing carried over.
        id = existing.id;
        await tx.user.update({
          where: { id },
          data: {
            firstName,
            lastName,
            status: AccountStatus.invited,
            passwordHash: null,
            mfaEnabled: false,
            mfaSecret: null,
            mfaSecretEnc: null,
            mfaPendingSecretEnc: null,
            mfaPendingCreatedAt: null,
            mfaEnrolledAt: null,
            mfaLastStep: null,
          },
        });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: id } });
        await tx.staffMemberRole.deleteMany({ where: { staffUserId: id } });
        await tx.staffMemberRole.createMany({
          data: dto.roles.map((role) => ({ staffUserId: id, role })),
        });
        await tx.staffInvite.updateMany({
          where: { staffUserId: id, state: StaffInviteState.pending },
          data: { state: StaffInviteState.superseded },
        });
        await tx.staffMember.update({
          where: { userId: id },
          data: {
            status: StaffStatus.invited,
            employmentPeriod: { increment: 1 },
            permVersion: { increment: 1 },
            rowVersion: { increment: 1 },
            acceptedAt: null,
            suspendedAt: null,
            suspendedBy: null,
            suspensionReason: null,
            suspensionSecurityIncident: false,
            deactivatedAt: null,
            deactivatedBy: null,
            deactivationReason: null,
            leaveFrom: null,
            leaveTo: null,
            leaveDelegateId: null,
            leaveNote: null,
            conflictDeclaration: Prisma.DbNull,
          },
        });
      } else {
        const user = await tx.user.create({
          data: {
            email,
            firstName,
            lastName,
            role: AppRole.admin,
            status: AccountStatus.invited,
            platformRoles: {
              create: {
                role: PlatformRole.staff,
                addedVia: RoleAddedVia.invite,
              },
            },
          },
        });
        id = user.id;
        await tx.staffMember.create({
          data: {
            userId: id,
            status: StaffStatus.invited,
            roles: { create: dto.roles.map((role) => ({ role })) },
          },
        });
      }
      await tx.staffInvite.create({
        data: {
          staffUserId: id,
          tokenHash: Buffer.from(hashToken(token), 'hex'),
          invitedBy: actorId,
          expiresAt,
        },
      });
      return id;
    });
    await this.sendInvite(email, firstName, token, expiresAt);
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: userId,
      action: 'staff.invited',
      metadata: { roles: dto.roles, rehire: Boolean(previous) },
    });
    return this.load(userId);
  }

  async resend(actorId: string, staffId: string) {
    await this.requirePermission(actorId, 'staff.manage');
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: staffInclude,
    });
    if (!member || member.status !== StaffStatus.invited)
      throw new ConflictException('Only pending invitations can be resent.');
    const sentToday = await this.prisma.staffInvite.count({
      where: {
        staffUserId: staffId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (sentToday >= 5)
      throw new GoneException(
        'This invitation was resent too many times today. Try again tomorrow.',
      );
    const token = generateRawToken();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffInvite.updateMany({
        where: { staffUserId: staffId, state: StaffInviteState.pending },
        data: { state: StaffInviteState.superseded },
      });
      await tx.staffInvite.create({
        data: {
          staffUserId: staffId,
          tokenHash: Buffer.from(hashToken(token), 'hex'),
          invitedBy: actorId,
          expiresAt,
        },
      });
      await tx.user.update({
        where: { id: staffId },
        data: { passwordHash: null },
      });
      await this.bump(tx, staffId, undefined, {});
    });
    await this.sendInvite(
      member.user.email,
      member.user.firstName ?? '',
      token,
      expiresAt,
    );
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.invite_resent',
    });
    return this.load(staffId);
  }

  async revoke(actorId: string, staffId: string, dto: StaffReasonDto) {
    await this.requirePermission(actorId, 'staff.manage');
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
    });
    if (!member || member.status !== StaffStatus.invited)
      throw new ConflictException('Only pending invitations can be revoked.');
    await this.prisma.$transaction(async (tx) => {
      await tx.staffInvite.updateMany({
        where: { staffUserId: staffId, state: StaffInviteState.pending },
        data: { state: StaffInviteState.revoked, revokedAt: new Date() },
      });
      await this.bump(tx, staffId, undefined, {
        status: StaffStatus.revoked,
        permVersion: { increment: 1 },
      });
      await tx.user.update({
        where: { id: staffId },
        data: { status: AccountStatus.inactive, passwordHash: null },
      });
    });
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.invite_revoked',
      metadata: { reason: dto.reason },
    });
    return this.load(staffId);
  }

  async changeRoles(
    actorId: string,
    staffId: string,
    dto: ChangeStaffRolesDto,
    reauthToken?: string,
    expectedVersion?: number,
  ) {
    await this.requirePermission(actorId, 'staff.manage');
    if (actorId === staffId)
      throw new ForbiddenException({
        code: 'SELF_ACTION',
        message: "You can't change your own roles. Ask another super admin.",
      });
    this.validateRoles(dto.roles);
    await this.requireStepUp(actorId, reauthToken);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: staffInclude,
    });
    if (
      !member ||
      member.status === StaffStatus.revoked ||
      member.status === StaffStatus.deactivated
    )
      throw new NotFoundException('This staff member is no longer available.');
    this.requireFresh(member.rowVersion, expectedVersion);
    const before = member.roles.map(({ role }) => role);
    if (
      before.length === dto.roles.length &&
      before.every((role) => dto.roles.includes(role))
    )
      throw new ConflictException("These are already this member's roles.");
    if (
      before.includes(StaffRole.super_admin) &&
      !dto.roles.includes(StaffRole.super_admin)
    )
      await this.ensureAnotherActiveSuperAdmin(staffId);
    const losesOwnerAbility =
      canOwnRequests(StaffStatus.active, before) &&
      !canOwnRequests(StaffStatus.active, dto.roles);
    let moved: MovedRequest[] = [];
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (losesOwnerAbility) {
        const moves = await this.handover.plan(
          tx,
          staffId,
          dto.ownedRequests,
          watToday(now),
        );
        moved = await this.handover.apply(
          tx,
          actorId,
          moves,
          "Owner's roles changed",
          now,
        );
        await this.clearDelegations(tx, staffId);
      }
      await tx.staffMemberRole.deleteMany({ where: { staffUserId: staffId } });
      await tx.staffMemberRole.createMany({
        data: dto.roles.map((role) => ({ staffUserId: staffId, role })),
      });
      await this.bump(tx, staffId, expectedVersion, {
        permVersion: { increment: 1 },
      });
    });
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.roles_changed',
      metadata: {
        before,
        after: dto.roles,
        reason: dto.reason,
        requestsMoved: moved.length,
      },
    });
    return {
      member: await this.load(staffId),
      offboarding: { ownedRequests: moved },
    };
  }

  async rename(
    actorId: string,
    staffId: string,
    dto: RenameStaffDto,
    expectedVersion?: number,
  ) {
    await this.requirePermission(actorId, 'staff.manage');
    if (actorId === staffId) {
      const actor = await this.prisma.staffMember.findUnique({
        where: { userId: actorId },
        include: { roles: true },
      });
      if (!actor?.roles.some(({ role }) => role === StaffRole.super_admin))
        throw new ForbiddenException({
          code: 'SELF_ACTION',
          message: "You can't change your own name. Ask a super admin.",
        });
    }
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      select: { rowVersion: true },
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    this.requireFresh(member.rowVersion, expectedVersion);
    await this.prisma.$transaction(async (tx) => {
      await this.bump(tx, staffId, expectedVersion, {});
      await tx.user.update({
        where: { id: staffId },
        data: { firstName, lastName },
      });
    });
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.renamed',
      metadata: { firstName, lastName, reason: dto.reason },
    });
    return this.load(staffId);
  }

  async setStatus(
    actorId: string,
    staffId: string,
    action: 'suspend' | 'reactivate' | 'deactivate',
    dto: SuspendStaffDto | DeactivateStaffDto | ReactivateStaffDto,
    reauthToken?: string,
    expectedVersion?: number,
  ) {
    await this.requirePermission(actorId, 'staff.manage');
    if (actorId === staffId)
      throw new ForbiddenException({
        code: 'SELF_ACTION',
        message: 'You cannot change your own account status.',
      });
    await this.requireStepUp(actorId, reauthToken);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: { roles: true },
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    this.requireFresh(member.rowVersion, expectedVersion);
    if (action === 'reactivate' && member.status !== StaffStatus.suspended)
      throw new ConflictException('Only suspended members can be reactivated.');
    if (action === 'suspend' && member.status === StaffStatus.suspended)
      throw new ConflictException('This staff account is already suspended.');
    if (action === 'suspend' && member.status === StaffStatus.invited)
      throw new ConflictException(
        "Pending invitations can't be suspended. Revoke the invitation instead.",
      );
    if (action === 'reactivate')
      this.validateRoles((dto as ReactivateStaffDto).roles);
    if (
      (action === 'suspend' || action === 'deactivate') &&
      (member.status === StaffStatus.invited ||
        member.status === StaffStatus.revoked ||
        member.status === StaffStatus.deactivated)
    )
      throw new GoneException('This staff member is no longer available.');
    const isActiveSuper =
      member.status === StaffStatus.active &&
      member.roles.some(({ role }) => role === StaffRole.super_admin);
    if (isActiveSuper && action !== 'reactivate')
      await this.ensureAnotherActiveSuperAdmin(staffId);
    const status =
      action === 'suspend'
        ? StaffStatus.suspended
        : action === 'deactivate'
          ? StaffStatus.deactivated
          : StaffStatus.active;
    const securityIncident =
      action === 'suspend' &&
      Boolean((dto as SuspendStaffDto).securityIncident);
    const resetMfa =
      action === 'reactivate' &&
      ((dto as ReactivateStaffDto).resetMfa ||
        member.suspensionSecurityIncident);
    let moved: MovedRequest[] = [];
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (action !== 'reactivate') {
        const moves = await this.handover.plan(
          tx,
          staffId,
          (dto as SuspendStaffDto | DeactivateStaffDto).ownedRequests,
          watToday(now),
        );
        moved = await this.handover.apply(
          tx,
          actorId,
          moves,
          action === 'suspend' ? 'Owner suspended' : 'Owner deactivated',
          now,
        );
        await this.clearDelegations(tx, staffId);
      }
      if (action === 'reactivate') {
        await tx.staffMemberRole.deleteMany({
          where: { staffUserId: staffId },
        });
        await tx.staffMemberRole.createMany({
          data: (dto as ReactivateStaffDto).roles.map((role) => ({
            staffUserId: staffId,
            role,
          })),
        });
      }
      await this.bump(tx, staffId, expectedVersion, {
        status,
        permVersion: { increment: 1 },
        ...(action === 'suspend'
          ? {
              suspendedAt: now,
              suspendedBy: actorId,
              suspensionReason: dto.reason,
              suspensionSecurityIncident: securityIncident,
              leaveFrom: null,
              leaveTo: null,
              leaveDelegateId: null,
              leaveNote: null,
            }
          : {}),
        ...(action === 'deactivate'
          ? {
              deactivatedAt: now,
              deactivatedBy: actorId,
              deactivationReason: dto.reason,
              leaveFrom: null,
              leaveTo: null,
              leaveDelegateId: null,
              leaveNote: null,
            }
          : {}),
        ...(action === 'reactivate'
          ? {
              suspendedAt: null,
              suspendedBy: null,
              suspensionReason: null,
              suspensionSecurityIncident: false,
            }
          : {}),
      });
      await tx.user.update({
        where: { id: staffId },
        data: {
          status:
            action === 'reactivate'
              ? AccountStatus.active
              : action === 'suspend'
                ? AccountStatus.suspended
                : AccountStatus.inactive,
          ...(action === 'deactivate' ? clearedSignIn : {}),
        },
      });
      if (action === 'deactivate')
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      if (resetMfa) {
        await tx.user.update({ where: { id: staffId }, data: clearedMfa });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      }
    });
    if (action !== 'reactivate')
      await this.sessions.revokeAllSessionsForUser(staffId);
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action:
        action === 'suspend'
          ? 'staff.suspended'
          : action === 'reactivate'
            ? 'staff.reactivated'
            : 'staff.deactivated',
      metadata: {
        reason: dto.reason,
        ...(action === 'suspend' ? { securityIncident } : {}),
        ...(action === 'reactivate'
          ? { roles: (dto as ReactivateStaffDto).roles, resetMfa }
          : { requestsMoved: moved.length }),
      },
    });
    const loaded = await this.load(staffId);
    if (action === 'reactivate') return loaded;
    const pendingInvitesSent = await this.prisma.staffInvite.count({
      where: { invitedBy: staffId, state: StaffInviteState.pending },
    });
    return {
      member: loaded,
      offboarding: {
        sessionsRevoked: true,
        ownedRequests: moved,
        pendingInvitesSent,
      },
    };
  }

  async resetMfa(
    actorId: string,
    staffId: string,
    dto: ResetStaffMfaDto,
    reauthToken?: string,
  ) {
    await this.requirePermission(actorId, 'staff.mfa.reset');
    if (actorId === staffId)
      throw new ForbiddenException({
        code: 'SELF_ACTION',
        message:
          "You can't reset your own sign-in verification. Ask another super admin.",
      });
    await this.requireStepUp(actorId, reauthToken);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
    });
    if (
      !member ||
      (member.status !== StaffStatus.active &&
        member.status !== StaffStatus.suspended)
    )
      throw new NotFoundException('This staff member is no longer available.');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: staffId }, data: clearedMfa });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      await this.bump(tx, staffId, undefined, {
        permVersion: { increment: 1 },
      });
    });
    await this.sessions.revokeAllSessionsForUser(staffId);
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.mfa_reset',
      metadata: { reason: dto.reason, identityCheck: dto.identityCheck },
    });
    return this.load(staffId);
  }

  /** Sets leave for the actor (`staffId === actorId`) or, with `staff.manage`, for anyone. */
  async setLeave(
    actorId: string,
    staffId: string,
    dto: SetStaffLeaveDto,
    expectedVersion?: number,
  ) {
    await this.requireSelfOrManager(actorId, staffId);
    const today = watToday();
    const from = parseDateOnly(dto.from);
    const to = parseDateOnly(dto.to);
    validateLeaveWindow(from, to, today);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: staffInclude,
    });
    if (!member || member.status !== StaffStatus.active)
      throw new NotFoundException('This staff member is no longer available.');
    this.requireFresh(member.rowVersion, expectedVersion);
    if (dto.delegateId)
      await this.requireDelegate(dto.delegateId, staffId, from, to);
    await this.prisma.$transaction((tx) =>
      this.bump(tx, staffId, expectedVersion, {
        leaveFrom: from,
        leaveTo: to,
        leaveDelegateId: dto.delegateId ?? null,
        leaveNote: dto.note?.trim() || null,
      }),
    );
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.leave_set',
      metadata: {
        from: dto.from,
        to: dto.to,
        delegateId: dto.delegateId ?? null,
      },
    });
    return this.load(staffId);
  }

  async clearLeave(actorId: string, staffId: string, expectedVersion?: number) {
    await this.requireSelfOrManager(actorId, staffId);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      select: { rowVersion: true },
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    this.requireFresh(member.rowVersion, expectedVersion);
    await this.prisma.$transaction((tx) =>
      this.bump(tx, staffId, expectedVersion, {
        leaveFrom: null,
        leaveTo: null,
        leaveDelegateId: null,
        leaveNote: null,
      }),
    );
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.leave_cleared',
    });
    return this.load(staffId);
  }

  private async requireSelfOrManager(actorId: string, staffId: string) {
    if (actorId === staffId) {
      requireActiveStaff(await this.actors.resolve(actorId));
      return;
    }
    await this.requirePermission(actorId, 'staff.manage');
  }

  private async requireDelegate(
    delegateId: string,
    staffId: string,
    from: Date,
    to: Date,
  ) {
    const invalid = () =>
      new UnprocessableEntityException(
        "Choose an active staff member who can own requests and isn't on leave.",
      );
    if (delegateId === staffId) throw invalid();
    const delegate = await this.prisma.staffMember.findUnique({
      where: { userId: delegateId },
      include: { roles: true },
    });
    if (
      !delegate ||
      !canOwnRequests(
        delegate.status,
        delegate.roles.map(({ role }) => role),
      )
    )
      throw invalid();
    const overlaps =
      delegate.leaveFrom && delegate.leaveTo
        ? delegate.leaveFrom <= to && from <= delegate.leaveTo
        : false;
    if (overlaps) throw invalid();
  }

  private async clearDelegations(
    tx: Prisma.TransactionClient,
    delegateId: string,
  ) {
    await tx.staffMember.updateMany({
      where: { leaveDelegateId: delegateId },
      data: { leaveDelegateId: null, rowVersion: { increment: 1 } },
    });
  }

  /** `If-Match` check before the transaction, for a friendlier error than the guarded write. */
  private requireFresh(current: number, expected?: number) {
    if (expected !== undefined && expected !== current)
      throw new AppError(409, 'VERSION_CONFLICT', STALE_MESSAGE);
  }

  /** Writes member fields and bumps `rowVersion`; with `expected` it is a compare-and-set. */
  private async bump(
    tx: Prisma.TransactionClient,
    staffId: string,
    expected: number | undefined,
    data: Prisma.StaffMemberUpdateManyMutationInput,
  ) {
    const result = await tx.staffMember.updateMany({
      where: {
        userId: staffId,
        ...(expected !== undefined ? { rowVersion: expected } : {}),
      },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new AppError(409, 'VERSION_CONFLICT', STALE_MESSAGE);
  }

  private async load(staffId: string) {
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: staffInclude,
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    const [projected] = await this.projectMany([member]);
    return projected;
  }

  private async workload(ids: readonly string[]) {
    const result = new Map<
      string,
      { openOwned: number; overdueOwned: number }
    >();
    if (!ids.length) return result;
    const open = await this.prisma.serviceRequest.groupBy({
      by: ['staffOwnerId'],
      where: { staffOwnerId: { in: [...ids] }, status: OPEN_REQUEST_FILTER },
      _count: { _all: true },
    });
    for (const row of open)
      if (row.staffOwnerId)
        result.set(row.staffOwnerId, {
          openOwned: row._count._all,
          overdueOwned: 0,
        });
    const overdue = await this.prisma.$queryRaw<
      { staffId: string; overdue: number }[]
    >(Prisma.sql`
      SELECT sr.staff_owner_id AS "staffId", COUNT(DISTINCT sr.id)::int AS "overdue"
      FROM service_requests sr
      JOIN approval_deadlines ad
        ON ad.request_id = sr.id AND ad.closed_at IS NULL AND ad.due_at <= ${new Date()}
      WHERE sr.staff_owner_id IN (${Prisma.join([...ids])})
        AND sr.status::text IN (${Prisma.join([...OPEN_REQUEST_FILTER.in])})
      GROUP BY sr.staff_owner_id
    `);
    for (const row of overdue) {
      const entry = result.get(row.staffId);
      if (entry) entry.overdueOwned = Number(row.overdue);
    }
    return result;
  }

  private async projectMany(members: StaffRow[]) {
    if (!members.length) return [];
    const ids = members.map((member) => member.userId);
    const now = new Date();
    const today = watToday(now);
    const [invites, workload, acceptances] = await Promise.all([
      this.prisma.staffInvite.findMany({
        where: { staffUserId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: {
          staffUserId: true,
          state: true,
          invitedBy: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      this.workload(ids),
      this.prisma.legalAcceptance.findMany({
        where: {
          userId: { in: ids },
          document: { kind: 'staff_policy' },
        },
        orderBy: { acceptedAt: 'desc' },
        select: {
          userId: true,
          acceptedAt: true,
          document: { select: { version: true } },
        },
      }),
    ]);
    const refIds = new Set<string>();
    for (const invite of invites) refIds.add(invite.invitedBy);
    for (const member of members) {
      for (const id of [
        member.suspendedBy,
        member.deactivatedBy,
        member.leaveDelegateId,
      ])
        if (id) refIds.add(id);
    }
    const names = new Map<string, string>();
    if (refIds.size) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: [...refIds] } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          name: true,
          email: true,
        },
      });
      for (const user of users) names.set(user.id, memberName(user));
    }
    const ref = (id: string | null): NamedRef =>
      id ? { id, name: names.get(id) ?? 'Unknown' } : null;
    const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;

    return members.map((member) => {
      const roles = member.roles.map(({ role }) => role);
      const own = invites.filter(
        (invite) => invite.staffUserId === member.userId,
      );
      const pending = own.find((invite) => invite.state === 'pending');
      const first = own[own.length - 1];
      const acceptance = acceptances.find(
        (item) => item.userId === member.userId,
      );
      const hasLeave = Boolean(member.leaveFrom && member.leaveTo);

      return {
        id: member.userId,
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        email: member.user.email,
        roles,
        status: member.status,
        permissions: permissionsForRoles(roles),
        canOwnRequests: canOwnRequests(member.status, roles),
        permVersion: member.permVersion,
        rowVersion: member.rowVersion,
        employmentPeriod: member.employmentPeriod,
        lastSignInAt: member.user.lastLoginAt,
        acceptedAt: member.acceptedAt,
        mfaEnrolledAt: member.user.mfaEnrolledAt,
        invitedAt: first?.createdAt ?? null,
        invitedBy: ref(first?.invitedBy ?? null),
        invite: pending
          ? {
              state: pending.expiresAt <= now ? 'expired' : 'pending',
              sentAt: pending.createdAt,
              expiresAt: pending.expiresAt,
              invitedBy: ref(pending.invitedBy),
              resendsToday: own.filter(
                (invite) => invite.createdAt.getTime() >= dayAgo,
              ).length,
            }
          : null,
        suspension: member.suspendedAt
          ? {
              at: member.suspendedAt,
              by: ref(member.suspendedBy),
              reason: member.suspensionReason,
              securityIncident: member.suspensionSecurityIncident,
            }
          : null,
        deactivation: member.deactivatedAt
          ? {
              at: member.deactivatedAt,
              by: ref(member.deactivatedBy),
              reason: member.deactivationReason,
            }
          : null,
        leave: hasLeave
          ? {
              from: dateOnly(member.leaveFrom as Date),
              to: dateOnly(member.leaveTo as Date),
              delegate: ref(member.leaveDelegateId),
              note: member.leaveNote,
              active: isOnLeave(member, today),
            }
          : null,
        workload: workload.get(member.userId) ?? {
          openOwned: 0,
          overdueOwned: 0,
        },
        conflictDeclaration: member.conflictDeclaration ?? null,
        policyAcceptance: acceptance
          ? {
              version: acceptance.document.version,
              acceptedAt: acceptance.acceptedAt,
            }
          : null,
      };
    });
  }

  async invitePreview(token: string) {
    const invite = await this.findInvite(token);
    // The accept call must name the current staff policy, so the page learns its version here.
    const policy = await this.prisma.legalDocument.findFirst({
      where: { kind: 'staff_policy' },
      orderBy: { publishedAt: 'desc' },
      select: { version: true, url: true },
    });
    return {
      firstName: invite.staffMember.user.firstName,
      lastName: invite.staffMember.user.lastName,
      email: invite.staffMember.user.email,
      roles: invite.staffMember.roles.map(({ role }) => role),
      expiresAt: invite.expiresAt,
      policy,
    };
  }

  async acceptInvite(
    token: string,
    password: string,
    policyVersion: string | undefined,
    conflictDeclaration: StaffConflictDeclarationDto,
  ) {
    const invite = await this.findInvite(token);
    const policy = await this.prisma.legalDocument.findFirst({
      where: { kind: 'staff_policy' },
      orderBy: { publishedAt: 'desc' },
    });
    const policyRequired = requestFlowFrom() !== 'v1';
    if (
      (policyRequired && (!policy || policy.version !== policyVersion)) ||
      !conflictDeclaration.statement.trim()
    )
      throw new UnprocessableEntityException(
        policyRequired
          ? 'Accept the current staff policy and complete the conflict declaration.'
          : 'Complete the conflict declaration.',
      );
    const passwordHash = await bcrypt.hash(password, 12);
    const acceptedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.staffInvite.updateMany({
        where: {
          id: invite.id,
          staffUserId: invite.staffUserId,
          state: StaffInviteState.pending,
          expiresAt: { gt: acceptedAt },
        },
        data: { state: StaffInviteState.consumed, consumedAt: acceptedAt },
      });
      if (consumed.count !== 1)
        throw new GoneException(
          'This invitation link is no longer valid. Ask an XPro super admin to send a new one.',
        );

      const activated = await tx.staffMember.updateMany({
        where: { userId: invite.staffUserId, status: StaffStatus.invited },
        data: {
          status: StaffStatus.active,
          acceptedAt,
          rowVersion: { increment: 1 },
          conflictDeclaration: {
            version: 1,
            declaredAt: acceptedAt.toISOString(),
            hasLinkedCustomerAccount:
              conflictDeclaration.hasLinkedCustomerAccount,
            linkedCustomerEmail:
              conflictDeclaration.linkedCustomerEmail ?? null,
            statement: conflictDeclaration.statement.trim(),
          },
        },
      });
      if (activated.count !== 1)
        throw new GoneException(
          'This invitation link is no longer valid. Ask an XPro super admin to send a new one.',
        );

      await tx.user.update({
        where: { id: invite.staffUserId },
        data: {
          passwordHash,
          status: AccountStatus.active,
          emailVerifiedAt: acceptedAt,
        },
      });

      if (policyRequired && policy) {
        await tx.legalAcceptance.upsert({
          where: {
            userId_documentId: {
              userId: invite.staffUserId,
              documentId: policy.id,
            },
          },
          create: {
            userId: invite.staffUserId,
            documentId: policy.id,
            source: 'staff_invite',
            ipAddress: this.requestContext.getIp(),
            userAgent: this.requestContext.getUserAgent(),
          },
          update: { acceptedAt },
        });
      }
    });

    this.audit.record({
      actorType: 'user',
      actorId: invite.staffUserId,
      entityType: 'staff',
      entityId: invite.staffUserId,
      action: 'staff.invite_accepted',
    });

    return { result: 'accepted' as const };
  }

  async verifyInviteMfa(enrollmentToken: string, code: string) {
    const tokenHash = Buffer.from(hashToken(enrollmentToken), 'hex');
    const authToken = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (
      !authToken ||
      authToken.purpose !== AuthTokenPurpose.mfa_enrollment ||
      authToken.usedAt ||
      authToken.expiresAt <= new Date()
    )
      throw new UnauthorizedException(
        'Enrollment token is invalid or expired.',
      );
    const secret = await this.redisAuth.getMfaPendingSecret(authToken.userId);
    const step = secret ? matchingTotpStep(secret, code) : null;
    if (step === null) throw new UnauthorizedException('Invalid MFA code.');
    const staff = await this.prisma.staffMember.findUnique({
      where: { userId: authToken.userId },
      include: { roles: true },
    });
    if (!staff || staff.status !== StaffStatus.invited)
      throw new UnauthorizedException('Invitation is no longer valid.');
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authToken.updateMany({
        where: {
          id: authToken.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new UnauthorizedException(
          'Enrollment token is invalid or expired.',
        );
      await tx.staffMember.update({
        where: { userId: staff.userId },
        data: {
          status: StaffStatus.active,
          acceptedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      });
      await tx.user.update({
        where: { id: staff.userId },
        data: {
          status: AccountStatus.active,
          mfaEnabled: true,
          mfaSecret: secret,
          mfaEnrolledAt: new Date(),
          mfaLastStep: step,
          emailVerifiedAt: new Date(),
          lastLoginAt: new Date(),
        },
      });
      const invitation = await tx.staffInvite.updateMany({
        where: {
          staffUserId: staff.userId,
          state: StaffInviteState.pending,
          expiresAt: { gt: new Date() },
        },
        data: { state: StaffInviteState.consumed, consumedAt: new Date() },
      });
      if (invitation.count !== 1)
        throw new UnauthorizedException('Invitation is no longer valid.');
    });
    await this.redisAuth.deleteMfaPendingSecret(staff.userId);
    const login = await this.redisAuth.generateToken({
      id: authToken.user.id,
      email: authToken.user.email,
      role: AppRole.admin,
      surfaces: [AppSurface.admin],
    });
    this.audit.record({
      actorType: 'user',
      actorId: staff.userId,
      entityType: 'staff',
      entityId: staff.userId,
      action: 'staff.invite_accepted',
    });
    return {
      result: 'authenticated',
      accessToken: login.access,
      accessTokenExpiresAt: login.expiresAt,
      user: {
        id: authToken.user.id,
        email: authToken.user.email,
        firstName: authToken.user.firstName,
        lastName: authToken.user.lastName,
        role: PlatformRole.staff,
      },
    };
  }

  private async findInvite(raw: string) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { tokenHash: Buffer.from(hashToken(raw), 'hex') },
      include: { staffMember: { include: { user: true, roles: true } } },
    });
    if (
      !invite ||
      invite.state !== StaffInviteState.pending ||
      invite.staffMember.status !== StaffStatus.invited
    )
      throw new GoneException(
        'This invitation link is no longer valid. Ask an XPro super admin to send a new one.',
      );
    if (invite.expiresAt <= new Date())
      throw new GoneException(
        'This invitation has expired. Ask an XPro super admin to resend it.',
      );
    return invite;
  }

  private async requirePermission(
    actorId: string,
    permission: Extract<StaffPermission, 'staff.manage' | 'staff.mfa.reset'>,
  ) {
    requirePermission(await this.actors.resolve(actorId), permission, {
      denied: 'Forbidden',
    });
  }

  private async requireStepUp(actorId: string, token?: string) {
    if (!token || !(await this.sessions.consumeReauthToken(actorId, token)))
      throw new ForbiddenException({
        code: 'REAUTH_REQUIRED',
        message: 'Reauthenticate to continue.',
      });
  }

  private async ensureAnotherActiveSuperAdmin(excludedId: string) {
    const count = await this.prisma.staffMemberRole.count({
      where: {
        role: StaffRole.super_admin,
        staffMember: {
          userId: { not: excludedId },
          status: StaffStatus.active,
        },
      },
    });
    if (count === 0)
      throw new ConflictException(
        'At least one active super admin is required.',
      );
  }

  private validateRoles(roles: StaffRole[]) {
    if (!roles.length || new Set(roles).size !== roles.length)
      throw new UnprocessableEntityException(
        'Choose at least one valid staff role.',
      );
  }

  private async sendInvite(
    email: string,
    name: string,
    token: string,
    expiresAt: Date,
  ) {
    await this.notifications.queueEmail({
      recipientEmail: email,
      type: 'staff_invite',
      templateKey: 'staff_invite',
      payload: { name, token, expiresAt: expiresAt.toISOString() },
    });
  }
}

const clearedMfa = {
  mfaEnabled: false,
  mfaSecret: null,
  mfaSecretEnc: null,
  mfaPendingSecretEnc: null,
  mfaPendingCreatedAt: null,
  mfaEnrolledAt: null,
  mfaLastStep: null,
} satisfies Prisma.UserUpdateInput;

const clearedSignIn = {
  passwordHash: null,
  ...clearedMfa,
} satisfies Prisma.UserUpdateInput;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
