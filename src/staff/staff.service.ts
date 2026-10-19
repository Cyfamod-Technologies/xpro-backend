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
import { PrismaService } from '../prisma/prisma.service';
import { SessionStore } from '../redis/session-store.service';
import { RedisAuthService } from '../auth/redis-auth.service';
import { generateTotpSecret, matchingTotpStep } from '../auth/totp.util';
import {
  canOwnRequests,
  permissionsForRoles,
  StaffPermission,
} from './staff-permissions';
import {
  ChangeStaffRolesDto,
  InviteStaffDto,
  ListStaffQueryDto,
  RenameStaffDto,
  ReactivateStaffDto,
  StaffReasonDto,
  StaffConflictDeclarationDto,
} from './dto/staff.dto';

const staffInclude = {
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      lastLoginAt: true,
    },
  },
  roles: { select: { role: true } },
  invites: {
    where: { state: StaffInviteState.pending },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { expiresAt: true, createdAt: true },
  },
} satisfies Prisma.StaffMemberInclude;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogsService,
    private readonly sessions: SessionStore,
    private readonly redisAuth: RedisAuthService,
    private readonly requestContext: RequestContextService,
  ) {}

  async list(actorId: string, query: ListStaffQueryDto) {
    await this.requirePermission(actorId, 'staff.manage');
    const where: Prisma.StaffMemberWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { roles: { some: { role: query.role } } } : {}),
      ...(query.q
        ? {
            user: {
              OR: [
                { firstName: { contains: query.q, mode: 'insensitive' } },
                { lastName: { contains: query.q, mode: 'insensitive' } },
                { email: { contains: query.q, mode: 'insensitive' } },
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
      members.map((member) => this.project(member)),
      total,
      query.page,
      query.limit,
    );
  }

  async myPermissions(actorId: string) {
    const member = await this.requireActiveStaff(actorId);
    const roles = member.roles.map(({ role }) => role);
    return {
      permissions: permissionsForRoles(roles),
      canOwnRequests: canOwnRequests(member.status, roles),
      permVersion: member.permVersion,
    };
  }

  async get(actorId: string, staffId: string) {
    await this.requirePermission(actorId, 'staff.manage');
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
      include: staffInclude,
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    return this.project(member);
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
    if (existing)
      throw new ConflictException('This email already belongs to an account.');
    const token = generateRawToken();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const member = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          role: AppRole.admin,
          status: AccountStatus.invited,
          platformRoles: {
            create: { role: PlatformRole.staff, addedVia: RoleAddedVia.invite },
          },
        },
      });
      const created = await tx.staffMember.create({
        data: {
          userId: user.id,
          status: StaffStatus.invited,
          roles: { create: dto.roles.map((role) => ({ role })) },
        },
      });
      await tx.staffInvite.create({
        data: {
          staffUserId: user.id,
          tokenHash: Buffer.from(hashToken(token), 'hex'),
          invitedBy: actorId,
          expiresAt,
        },
      });
      return tx.staffMember.findUniqueOrThrow({
        where: { userId: created.userId },
        include: staffInclude,
      });
    });
    await this.sendInvite(
      member.user.email,
      member.user.firstName ?? dto.firstName,
      token,
      expiresAt,
    );
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: member.userId,
      action: 'staff.invited',
      metadata: { roles: dto.roles },
    });
    return this.project(member);
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
    return this.get(actorId, staffId);
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
      await tx.staffMember.update({
        where: { userId: staffId },
        data: { status: StaffStatus.revoked, permVersion: { increment: 1 } },
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
    return this.get(actorId, staffId);
  }

  async changeRoles(
    actorId: string,
    staffId: string,
    dto: ChangeStaffRolesDto,
    reauthToken?: string,
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
    await this.prisma.$transaction(async (tx) => {
      await tx.staffMemberRole.deleteMany({ where: { staffUserId: staffId } });
      await tx.staffMemberRole.createMany({
        data: dto.roles.map((role) => ({ staffUserId: staffId, role })),
      });
      await tx.staffMember.update({
        where: { userId: staffId },
        data: { permVersion: { increment: 1 } },
      });
    });
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.roles_changed',
      metadata: { before, after: dto.roles, reason: dto.reason },
    });
    return this.get(actorId, staffId);
  }

  async rename(actorId: string, staffId: string, dto: RenameStaffDto) {
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
    await this.prisma.user
      .update({
        where: { id: staffId },
        data: { firstName, lastName },
      })
      .catch(() => {
        throw new NotFoundException(
          'This staff member is no longer available.',
        );
      });
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.renamed',
      metadata: { firstName, lastName, reason: dto.reason },
    });
    return this.get(actorId, staffId);
  }

  async setStatus(
    actorId: string,
    staffId: string,
    action: 'suspend' | 'reactivate' | 'deactivate',
    dto: StaffReasonDto | ReactivateStaffDto,
    reauthToken?: string,
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
    if (action === 'reactivate' && member.status !== StaffStatus.suspended)
      throw new ConflictException('Only suspended members can be reactivated.');
    if (action === 'reactivate')
      this.validateRoles((dto as ReactivateStaffDto).roles);
    if (
      action !== 'reactivate' &&
      (member.status === StaffStatus.invited ||
        member.status === StaffStatus.revoked ||
        member.status === StaffStatus.deactivated)
    )
      throw new GoneException(
        'This staff member cannot be changed from its current status.',
      );
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
    await this.prisma.$transaction(async (tx) => {
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
      await tx.staffMember.update({
        where: { userId: staffId },
        data: { status, permVersion: { increment: 1 } },
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
          ...(action === 'deactivate'
            ? {
                passwordHash: null,
                mfaEnabled: false,
                mfaSecret: null,
                mfaSecretEnc: null,
                mfaEnrolledAt: null,
                mfaLastStep: null,
              }
            : {}),
        },
      });
      if (action === 'deactivate')
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      if (action === 'reactivate' && (dto as ReactivateStaffDto).resetMfa) {
        await tx.user.update({
          where: { id: staffId },
          data: {
            mfaEnabled: false,
            mfaSecret: null,
            mfaSecretEnc: null,
            mfaEnrolledAt: null,
            mfaLastStep: null,
          },
        });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      }
    });
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
      metadata: { reason: dto.reason },
    });
    return this.get(actorId, staffId);
  }

  async resetMfa(
    actorId: string,
    staffId: string,
    dto: StaffReasonDto,
    reauthToken?: string,
  ) {
    const actor = await this.requirePermission(actorId, 'staff.mfa.reset');
    if (actorId === staffId)
      throw new ForbiddenException({
        code: 'SELF_ACTION',
        message: 'You cannot reset your own MFA.',
      });
    await this.requireStepUp(actorId, reauthToken);
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: staffId },
    });
    if (!member)
      throw new NotFoundException('This staff member is no longer available.');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: staffId },
        data: {
          mfaEnabled: false,
          mfaSecret: null,
          mfaSecretEnc: null,
          mfaPendingSecretEnc: null,
          mfaPendingCreatedAt: null,
          mfaEnrolledAt: null,
          mfaLastStep: null,
        },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: staffId } });
      await tx.staffMember.update({
        where: { userId: staffId },
        data: { permVersion: { increment: 1 } },
      });
    });
    await this.sessions.revokeAllSessionsForUser(staffId);
    this.audit.record({
      actorType: 'user',
      actorId,
      entityType: 'staff',
      entityId: staffId,
      action: 'staff.mfa_reset',
      metadata: { reason: dto.reason },
    });
    return this.get(actorId, staffId);
  }

  async invitePreview(token: string) {
    const invite = await this.findInvite(token);
    return {
      firstName: invite.staffMember.user.firstName,
      lastName: invite.staffMember.user.lastName,
      email: invite.staffMember.user.email,
      roles: invite.staffMember.roles.map(({ role }) => role),
      expiresAt: invite.expiresAt,
    };
  }

  async acceptInvite(
    token: string,
    password: string,
    policyVersion: string,
    conflictDeclaration: StaffConflictDeclarationDto,
  ) {
    const invite = await this.findInvite(token);
    const policy = await this.prisma.legalDocument.findFirst({
      where: { kind: 'staff_policy' },
      orderBy: { publishedAt: 'desc' },
    });
    if (
      !policy ||
      policy.version !== policyVersion ||
      !conflictDeclaration.statement.trim()
    )
      throw new UnprocessableEntityException(
        'Accept the current staff policy and complete the conflict declaration.',
      );
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.update({
      where: { id: invite.staffUserId },
      data: { passwordHash, status: AccountStatus.invited },
    });
    await this.prisma.legalAcceptance.upsert({
      where: { userId_documentId: { userId: user.id, documentId: policy.id } },
      create: {
        userId: user.id,
        documentId: policy.id,
        source: 'staff_invite',
        ipAddress: this.requestContext.getIp(),
        userAgent: this.requestContext.getUserAgent(),
      },
      update: { acceptedAt: new Date() },
    });
    const { secret, otpauthUrl } = generateTotpSecret(user.email);
    await this.redisAuth.storeMfaPendingSecret(user.id, secret);
    const enrollmentToken = generateRawToken();
    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        purpose: AuthTokenPurpose.mfa_enrollment,
        tokenHash: Buffer.from(hashToken(enrollmentToken), 'hex'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    return {
      result: 'mfa_enrollment_required',
      enrollmentToken,
      secret,
      otpauthUrl,
    };
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
    if (step === null)
      throw new UnauthorizedException('Invalid MFA code.');
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
        data: { status: StaffStatus.active },
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
    const member = await this.requireActiveStaff(actorId);
    const roles = member.roles.map(({ role }) => role);
    if (!permissionsForRoles(roles).includes(permission))
      throw new ForbiddenException();
    return member;
  }

  private async requireActiveStaff(actorId: string) {
    const member = await this.prisma.staffMember.findUnique({
      where: { userId: actorId },
      include: { roles: true },
    });
    const isStaff = await this.prisma.userRole.findFirst({
      where: { userId: actorId, role: PlatformRole.staff },
    });
    if (!member || !isStaff)
      throw new ForbiddenException(
        'This action is not available for your account type.',
      );
    if (member.status !== StaffStatus.active)
      throw new ForbiddenException('Your staff account is not active.');
    return member;
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

  private project(
    member: Prisma.StaffMemberGetPayload<{ include: typeof staffInclude }>,
  ) {
    return {
      id: member.userId,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      email: member.user.email,
      roles: member.roles.map(({ role }) => role),
      status: member.status,
      permissions: permissionsForRoles(member.roles.map(({ role }) => role)),
      canOwnRequests: canOwnRequests(
        member.status,
        member.roles.map(({ role }) => role),
      ),
      invite: member.invites[0] ?? null,
      lastSignInAt: member.user.lastLoginAt,
      permVersion: member.permVersion,
    };
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
