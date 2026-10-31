import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AccountStatus,
  AppRole,
  AppSurface,
  AuthTokenPurpose,
  LegalDocumentKind,
  Prisma,
  RoleAddedVia,
  StaffStatus,
  WorkspaceRole,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { generateRawToken, hashToken } from '../common/utils/token.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { activeWorkspaceRole } from '../platform/actor/active-role';
import { AppError } from '../platform/errors/app-error';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionStore } from '../redis/session-store.service';
import {
  AddRoleDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResendVerificationDto,
  ResetPasswordDto,
  RegisterDto,
  UpdateMeDto,
  VerifyEmailTokenDto,
} from './dto/auth.dto';
import { RedisAuthService } from './redis-auth.service';
import { generateTotpSecret, matchingTotpStep } from './totp.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly notifications: NotificationsService,
    private readonly redisAuth: RedisAuthService,
    private readonly sessions: SessionStore,
  ) {}

  async legalDocuments(role: 'customer' | 'provider') {
    const kinds: LegalDocumentKind[] =
      role === 'provider'
        ? ['terms', 'privacy', 'provider_agreement']
        : ['terms', 'privacy'];
    const documents = await this.prisma.legalDocument.findMany({
      where: { kind: { in: kinds }, publishedAt: { lte: new Date() } },
      orderBy: { publishedAt: 'desc' },
      distinct: ['kind'],
      select: { kind: true, version: true, url: true, publishedAt: true },
    });
    return documents;
  }

  async listSessions(userId: string, role: string, currentSid?: string) {
    const sessions = await this.sessions.getAllSessions(userId, role);
    // Never return the access token material.
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      current: s.sessionId === currentSid,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeSession(userId: string, role: string, sessionId: string) {
    await this.sessions.revokeSession(userId, sessionId, role);
    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'session',
      entityId: sessionId,
      action: 'session_revoked',
    });
    return { message: 'Session revoked.' };
  }

  async revokeAllSessions(userId: string) {
    await this.sessions.revokeAllSessionsForUser(userId);
    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'user',
      entityId: userId,
      action: 'all_sessions_revoked',
    });
    return { message: 'All sessions revoked.' };
  }

  async loginHistory(userId: string, limit = 20) {
    const events = await this.prisma.auditLog.findMany({
      where: { actorId: userId, action: 'login' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: { ipAddress: true, metadata: true, createdAt: true },
    });
    return events;
  }

  /**
   * Verifies the user's password (and MFA if enabled) and issues a short-lived
   * reauthentication proof token used to authorize destructive/security actions.
   */
  async reauthenticate(userId: string, password: string, mfaCode?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, mfaEnabled: true, mfaSecret: true },
    });
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'Password authentication is not available for this account',
      );
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Incorrect password');
    if (user.mfaEnabled) {
      if (
        !mfaCode ||
        !user.mfaSecret ||
        !(await this.consumeTotp(userId, user.mfaSecret, mfaCode))
      ) {
        throw new UnauthorizedException('Valid MFA code required');
      }
    }
    const token = randomBytes(32).toString('hex');
    await this.sessions.setReauthToken(userId, token);
    return { reauthToken: token, expiresInSeconds: 300 };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();

    // Validate before the account lookup so a request behaves the same whether
    // or not the email is already registered.
    const documents = await this.prisma.legalDocument.findMany({
      where: {
        kind: {
          in:
            dto.role === 'provider'
              ? ['terms', 'privacy', 'provider_agreement']
              : ['terms', 'privacy'],
        },
        publishedAt: { lte: new Date() },
      },
      orderBy: { publishedAt: 'desc' },
      distinct: ['kind'],
    });
    const acceptedVersions = {
      terms: dto.acceptedTerms?.termsVersion,
      privacy: dto.acceptedTerms?.privacyVersion,
      provider_agreement: dto.acceptedTerms?.providerAgreementVersion,
      staff_policy: undefined,
    };
    if (
      documents.some(
        (document) => acceptedVersions[document.kind] !== document.version,
      )
    ) {
      throw new BadRequestException('Accept the current terms to continue.');
    }

    // The response never reveals whether the email is already registered: every
    // branch returns the same body and existing accounts are told by email.
    const response = { statusCode: 202, email, status: 'pending_verification' };
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        name: true,
        status: true,
        deletionScheduledFor: true,
        staffMember: { select: { status: true } },
      },
    });
    if (existing) {
      if (existing.status === 'unverified' && !existing.staffMember) {
        await this.replaceUnverifiedSignup(existing, {
          dto,
          firstName,
          lastName,
          documents,
        });
      } else {
        await this.notifyExistingAccount(existing);
      }
      return response;
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const rawToken = generateRawToken();
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          firstName,
          lastName,
          passwordHash,
          status: 'unverified',
          platformRoles: {
            create: {
              role: dto.role,
              addedVia: RoleAddedVia.signup,
            },
          },
        },
      });
      await tx.authToken.create({
        data: this.emailVerifyTokenData(created.id, rawToken, dto.returnTo),
      });
      if (documents.length > 0)
        await tx.legalAcceptance.createMany({
          data: documents.map((document) => ({
            userId: created.id,
            documentId: document.id,
            source: 'signup',
          })),
        });
      return created;
    });

    await this.notifications.queueEmail({
      recipientEmail: user.email,
      recipientUserId: user.id,
      type: 'email_verification',
      templateKey: 'email_verification',
      payload: { token: rawToken, firstName },
    });
    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      entityId: user.id,
      action: 'signup_created',
    });
    return response;
  }

  private emailVerifyTokenData(
    userId: string,
    rawToken: string,
    returnTo?: string,
  ) {
    return {
      userId,
      purpose: AuthTokenPurpose.email_verify,
      tokenHash: Buffer.from(hashToken(rawToken), 'hex'),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      metadata: returnTo ? { returnTo } : undefined,
    };
  }

  /**
   * A signup for an unverified email replaces the abandoned attempt, so the
   * person who completes verification is the one who last submitted the form.
   */
  private async replaceUnverifiedSignup(
    user: { id: string; email: string },
    input: {
      dto: RegisterDto;
      firstName: string;
      lastName: string;
      documents: { id: string }[];
    },
  ) {
    const { dto, firstName, lastName, documents } = input;
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const rawToken = generateRawToken();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { firstName, lastName, passwordHash },
      });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({
        data: {
          userId: user.id,
          role: dto.role,
          addedVia: RoleAddedVia.signup,
        },
      });
      await tx.legalAcceptance.deleteMany({ where: { userId: user.id } });
      if (documents.length > 0)
        await tx.legalAcceptance.createMany({
          data: documents.map((document) => ({
            userId: user.id,
            documentId: document.id,
            source: 'signup',
          })),
        });
      await tx.authToken.updateMany({
        where: {
          userId: user.id,
          purpose: AuthTokenPurpose.email_verify,
          usedAt: null,
        },
        data: { usedAt: now },
      });
      await tx.authToken.create({
        data: this.emailVerifyTokenData(user.id, rawToken, dto.returnTo),
      });
    });

    await this.notifications.queueEmail({
      recipientEmail: user.email,
      recipientUserId: user.id,
      type: 'email_verification',
      templateKey: 'email_verification',
      payload: { token: rawToken, firstName },
    });
    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      entityId: user.id,
      action: 'signup_replaced',
    });
  }

  /**
   * Tells the owner of an existing account that someone tried to sign up with
   * their email. Nothing about the account changes.
   */
  private async notifyExistingAccount(user: {
    id: string;
    email: string;
    firstName: string | null;
    name: string | null;
    status: AccountStatus;
    deletionScheduledFor: Date | null;
    staffMember: { status: StaffStatus } | null;
  }) {
    const firstName = user.firstName ?? user.name ?? undefined;
    const base = {
      recipientEmail: user.email,
      recipientUserId: user.id,
      cooldown: { key: `account_exists:${user.id}`, seconds: 600 },
    };

    if (user.staffMember) {
      if (['invited', 'active', 'suspended'].includes(user.staffMember.status))
        await this.notifications.queueEmail({
          ...base,
          type: 'staff_account_exists',
          templateKey: 'staff_account_exists',
          payload: { firstName },
        });
      return;
    }

    if (user.status === 'active' || user.status === 'suspended') {
      await this.notifications.queueEmail({
        ...base,
        type: 'account_exists',
        templateKey: 'account_exists',
        payload: { firstName },
      });
    } else if (user.status === 'pending_deletion') {
      await this.notifications.queueEmail({
        ...base,
        type: 'account_exists',
        templateKey: 'account_exists',
        payload: {
          firstName,
          deletionScheduledFor: user.deletionScheduledFor?.toISOString(),
        },
      });
    }
  }

  async verifyEmailToken(dto: VerifyEmailTokenDto) {
    const now = new Date();
    const tokenHash = Buffer.from(hashToken(dto.token), 'hex');
    const token = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            emailVerifiedAt: true,
            status: true,
          },
        },
      },
    });
    if (
      !token ||
      token.purpose !== AuthTokenPurpose.email_verify ||
      token.usedAt ||
      token.expiresAt <= now ||
      token.user.emailVerifiedAt
    ) {
      throw new BadRequestException(
        'This verification link is invalid or has already been used.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new BadRequestException(
          'This verification link is invalid or has already been used.',
        );
      }
      await tx.user.update({
        where: { id: token.userId },
        data: { status: 'active', emailVerifiedAt: now },
      });
    });
    this.auditLogs.record({
      actorType: 'user',
      actorId: token.userId,
      entityType: 'auth',
      entityId: token.userId,
      action: 'email_verified',
    });
    const metadata = token.metadata as { returnTo?: string } | null;
    return {
      verified: true,
      email: token.user.email,
      ...(metadata?.returnTo ? { returnTo: metadata.returnTo } : {}),
    };
  }

  async resendEmailVerification(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        name: true,
        firstName: true,
        emailVerifiedAt: true,
        status: true,
      },
    });
    if (user && !user.emailVerifiedAt && user.status === 'unverified') {
      const rawToken = generateRawToken();
      // Keep the latest returnTo so verifying a resent link still resumes the
      // flow the person started from.
      const previous = await this.prisma.authToken.findFirst({
        where: {
          userId: user.id,
          purpose: AuthTokenPurpose.email_verify,
          usedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      const returnTo = (previous?.metadata as { returnTo?: string } | null)
        ?.returnTo;
      await this.prisma.$transaction([
        this.prisma.authToken.updateMany({
          where: {
            userId: user.id,
            purpose: AuthTokenPurpose.email_verify,
            usedAt: null,
          },
          data: { usedAt: new Date() },
        }),
        this.prisma.authToken.create({
          data: this.emailVerifyTokenData(user.id, rawToken, returnTo),
        }),
      ]);
      await this.notifications.queueEmail({
        recipientEmail: user.email,
        recipientUserId: user.id,
        type: 'email_verification',
        templateKey: 'email_verification',
        payload: {
          token: rawToken,
          firstName: user.firstName ?? user.name ?? undefined,
        },
      });
    }
    return {
      message:
        'If the account is awaiting verification, a new email will be sent',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        platformRoles: { select: { role: true } },
        staffMember: { select: { status: true } },
      },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }

    if (user.mfaEnabled) {
      if (!dto.mfaCode) {
        throw new UnauthorizedException('MFA code required');
      }
      if (!user.mfaSecret) {
        throw new UnauthorizedException('MFA setup is incomplete');
      }
      if (!(await this.consumeTotp(user.id, user.mfaSecret, dto.mfaCode))) {
        throw new UnauthorizedException('Invalid MFA code');
      }
    }

    // Session lifetime is a deployment-level setting. When unset,
    // RedisAuthService applies its own default.
    const configuredMinutes = Number(process.env.SESSION_DURATION_MINUTES);
    const expirySeconds =
      Number.isFinite(configuredMinutes) && configuredMinutes > 0
        ? configuredMinutes * 60
        : undefined;

    const tokenData = await this.redisAuth.generateToken(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        surfaces: this.surfacesForRole(user.role),
      },
      expirySeconds,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      action: 'login',
    });

    return {
      accessToken: tokenData.access,
      tokenType: 'Bearer',
      sessionId: tokenData.sessionId,
      expiresAt: tokenData.expiresAt,
      expiresIn: tokenData.expiresIn,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        platformRoles: user.platformRoles.map(({ role }) => role),
        activeRole: activeWorkspaceRole(
          user.platformRoles.map(({ role }) => role),
          user.lastActiveRole,
        ),
        staffStatus: user.staffMember?.status ?? null,
        emailVerified: !!user.emailVerifiedAt,
        phone: user.phoneE164,
        phoneVerified: !!user.phoneVerifiedAt,
        phoneVerifiedAt: user.phoneVerifiedAt,
        onboardingCompleted: user.onboardingCompleted,
        mfaEnabled: user.mfaEnabled,
      },
    };
  }

  async refreshToken(user: { id: string; sid?: string; role: AppRole }) {
    const tokenData = await this.redisAuth.refreshTokenBySession(
      user.id,
      user.sid,
      user.role,
    );

    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      action: 'token_refreshed',
    });

    return {
      accessToken: tokenData.access,
      tokenType: 'Bearer',
      sessionId: tokenData.sessionId,
      expiresAt: tokenData.expiresAt,
      expiresIn: tokenData.expiresIn,
      role: tokenData.role,
      surfaces: tokenData.surfaces,
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        mfaEnabled: true,
        lastLoginAt: true,
        emailVerifiedAt: true,
        phoneE164: true,
        phoneVerifiedAt: true,
        onboardingCompleted: true,
        avatarUrl: true,
        language: true,
        timezone: true,
        notificationPreferences: true,
        lastActiveRole: true,
        platformRoles: { select: { role: true } },
        staffMember: { select: { status: true } },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) throw new UnauthorizedException('Authentication failed');

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      platformRoles: user.platformRoles.map(({ role }) => role),
      activeRole: activeWorkspaceRole(
        user.platformRoles.map(({ role }) => role),
        user.lastActiveRole,
      ),
      staffStatus: user.staffMember?.status ?? null,
      emailVerified: !!user.emailVerifiedAt,
      phone: user.phoneE164,
      phoneVerified: !!user.phoneVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
      onboardingCompleted: user.onboardingCompleted,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt,
      avatarUrl: user.avatarUrl,
      language: user.language,
      timezone: user.timezone,
      notificationPreferences: user.notificationPreferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Adds the customer or provider role to the signed-in account (01 §6.16) and
   * makes it the active workspace. Sessions stay valid: no new registration.
   */
  async addRole(userId: string, dto: AddRoleDto) {
    const user = await this.workspaceAccount(userId);
    if (user.status !== 'active')
      throw new AppError(403, 'FORBIDDEN', 'This account is not active.');
    if (user.roles.includes(dto.role))
      throw new AppError(409, 'STATE_CONFLICT', 'You already have this role.', {
        current: { platformRoles: user.roles },
      });

    // Terms and privacy were accepted at signup; only the provider role adds an agreement.
    const agreement =
      dto.role === 'provider'
        ? await this.prisma.legalDocument.findFirst({
            where: {
              kind: 'provider_agreement',
              publishedAt: { lte: new Date() },
            },
            orderBy: { publishedAt: 'desc' },
          })
        : null;
    if (
      agreement &&
      dto.acceptedTerms?.providerAgreementVersion !== agreement.version
    )
      throw new BadRequestException('Accept the current terms to continue.');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userRole.create({
          data: { userId, role: dto.role, addedVia: RoleAddedVia.self_service },
        });
        if (agreement)
          await tx.legalAcceptance.create({
            data: { userId, documentId: agreement.id, source: 'role_added' },
          });
        await tx.user.update({
          where: { id: userId },
          data: { lastActiveRole: dto.role },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppError(
          409,
          'STATE_CONFLICT',
          'You already have this role.',
          { current: { platformRoles: [...user.roles, dto.role] } },
        );
      throw error;
    }

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'user',
      entityId: userId,
      action: 'account.role_added',
      metadata: { role: dto.role },
    });
    return this.me(userId);
  }

  /** Switches the workspace of an account holding both roles (ROLE-1). */
  async setActiveRole(userId: string, role: WorkspaceRole) {
    const user = await this.workspaceAccount(userId);
    if (!user.roles.includes(role))
      throw new AppError(
        403,
        'FORBIDDEN',
        "This account doesn't have that role.",
      );
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastActiveRole: role },
    });
    return this.me(userId);
  }

  /** The account's customer/provider roles; staff accounts are refused (Q11). */
  private async workspaceAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        platformRoles: { select: { role: true } },
        staffMember: { select: { status: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Authentication failed');
    const roles = user.platformRoles.map(({ role }) => role);
    if (roles.includes('staff') || user.staffMember)
      throw new AppError(
        403,
        'FORBIDDEN',
        "Staff accounts can't add customer or provider roles.",
      );
    return { status: user.status, roles };
  }

  async logout(userId: string, sid: string | undefined, role: AppRole) {
    if (sid) {
      await this.redisAuth.revokeSession(userId, sid, role);
    }

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'auth',
      action: 'logout',
    });

    return { message: 'Logged out successfully' };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.notificationPreferences !== undefined && {
          notificationPreferences:
            dto.notificationPreferences as Prisma.InputJsonValue,
        }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        mfaEnabled: true,
        lastLoginAt: true,
        avatarUrl: true,
        language: true,
        timezone: true,
        notificationPreferences: true,
      },
    });

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'user',
      entityId: userId,
      action: 'profile_updated',
      metadata: dto,
    });

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      mfaEnabled: user.mfaEnabled,
      avatarUrl: user.avatarUrl,
      language: user.language,
      timezone: user.timezone,
      notificationPreferences: user.notificationPreferences,
    };
  }

  async setupMfa(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, mfaEnabled: true },
    });

    if (!user) throw new UnauthorizedException('Authentication failed');
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled on this account');
    }

    const { secret, otpauthUrl } = generateTotpSecret(user.email);
    await this.redisAuth.storeMfaPendingSecret(userId, secret);

    return { secret, otpauthUrl };
  }

  async confirmMfa(userId: string, code: string) {
    const secret = await this.redisAuth.getMfaPendingSecret(userId);
    if (!secret) {
      throw new BadRequestException(
        'No pending MFA setup found — call /auth/mfa/setup first',
      );
    }

    const step = matchingTotpStep(secret, code);
    if (step === null) {
      throw new UnauthorizedException('Invalid MFA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaSecret: secret,
        mfaEnabled: true,
        mfaEnrolledAt: new Date(),
        mfaLastStep: step,
      },
    });

    await this.redisAuth.deleteMfaPendingSecret(userId);

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'auth',
      entityId: userId,
      action: 'mfa_enabled',
    });

    return { mfaEnabled: true };
  }

  async disableMfa(userId: string, dto: { password: string; code?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, mfaEnabled: true, mfaSecret: true },
    });

    if (!user?.passwordHash)
      throw new UnauthorizedException('Authentication failed');

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk)
      throw new BadRequestException('Current password is incorrect');

    if (user.mfaEnabled) {
      if (!dto.code) throw new UnauthorizedException('MFA code required');
      if (!user.mfaSecret)
        throw new UnauthorizedException('MFA setup is incomplete');
      if (!(await this.consumeTotp(userId, user.mfaSecret, dto.code))) {
        throw new UnauthorizedException('Invalid MFA code');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaEnrolledAt: null,
        mfaLastStep: null,
      },
    });

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'auth',
      entityId: userId,
      action: 'mfa_disabled',
    });

    return { mfaEnabled: false };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const currentOk = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!currentOk) {
      throw new BadRequestException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    await this.redisAuth.revokeAllSessionsForUser(userId);

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'auth',
      entityId: userId,
      action: 'password_changed',
    });

    return { message: 'Password changed successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (user) {
      const raw = generateRawToken();
      await this.redisAuth.storePasswordResetToken(user.id, hashToken(raw));

      await this.notifications.queueEmail({
        recipientEmail: user.email,
        recipientUserId: user.id,
        type: 'password_reset',
        templateKey: 'password_reset',
        payload: {
          resetToken: raw,
          firstName: user.firstName ?? user.lastName ?? undefined,
        },
      });

      this.auditLogs.record({
        actorType: 'system',
        actorId: null,
        entityType: 'auth',
        entityId: user.id,
        action: 'password_reset_requested',
      });
    }

    return {
      message: 'If the account exists, reset instructions will be sent',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const userId = await this.redisAuth.consumePasswordResetToken(
      hashToken(dto.token),
    );
    if (!userId) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    await this.redisAuth.revokeAllSessionsForUser(userId);

    this.auditLogs.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'auth',
      action: 'password_reset',
    });

    return { message: 'Password reset successful' };
  }

  private surfacesForRole(role: AppRole): AppSurface[] {
    if (role === AppRole.super_admin || role === AppRole.admin) {
      return [AppSurface.admin];
    }
    return [AppSurface.user];
  }

  private async consumeTotp(
    userId: string,
    secret: string,
    code: string,
  ): Promise<boolean> {
    const step = matchingTotpStep(secret, code);
    if (step === null) return false;

    const result = await this.prisma.user.updateMany({
      where: {
        id: userId,
        status: 'active',
        mfaEnabled: true,
        mfaSecret: secret,
        OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }],
      },
      data: { mfaLastStep: step },
    });
    return result.count === 1;
  }
}
