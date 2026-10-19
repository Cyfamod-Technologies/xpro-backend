import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AppRole,
  AppSurface,
  AuthTokenPurpose,
  LegalDocumentKind,
  PlatformRole,
  Prisma,
  RoleAddedVia,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import {
  generateNumericOtp,
  generateRawToken,
  hashToken,
} from '../common/utils/token.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionStore } from '../redis/session-store.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResendVerificationDto,
  ResetPasswordDto,
  RegisterDto,
  SignupDto,
  UpdateMeDto,
  VerifyEmailDto,
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
    const kinds: LegalDocumentKind[] = role === 'provider'
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

  async signup(dto: SignupDto) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }

    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const verificationCode = generateNumericOtp(6);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName,
        lastName,
        role: AppRole.user,
        status: 'invited',
      },
    });

    await this.redisAuth.storeEmailVerificationCode(
      user.id,
      hashToken(verificationCode),
    );

    await this.notifications.queueEmail({
      recipientEmail: user.email,
      recipientUserId: user.id,
      type: 'email_verification',
      templateKey: 'email_verification',
      payload: {
        code: verificationCode,
        firstName,
      },
    });

    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      entityId: user.id,
      action: 'signup_created',
    });

    return {
      message:
        'Registration successful. Check your email for a verification code.',
      verification: {
        required: true,
        email: user.email,
      },
    };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    // Keep registration responses non-enumerating, including for existing accounts.
    if (existing)
      return { statusCode: 202, email, status: 'pending_verification' };

    const documents = await this.prisma.legalDocument.findMany({
      where: {
        kind: {
          in:
            dto.role === 'provider'
              ? ['terms', 'privacy', 'provider_agreement']
              : ['terms', 'privacy'],
        },
      },
      orderBy: { publishedAt: 'desc' },
      distinct: ['kind'],
    });
    const versions = new Map(
      documents.map((document) => [document.kind, document.version]),
    );
    if (
      versions.get('terms') !== dto.acceptedTerms.termsVersion ||
      versions.get('privacy') !== dto.acceptedTerms.privacyVersion ||
      (dto.role === 'provider' &&
        versions.get('provider_agreement') !==
          dto.acceptedTerms.providerAgreementVersion)
    ) {
      throw new BadRequestException('Accept the current terms to continue.');
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
              role: dto.role as PlatformRole,
              addedVia: RoleAddedVia.signup,
            },
          },
        },
      });
      await tx.authToken.create({
        data: {
          userId: created.id,
          purpose: AuthTokenPurpose.email_verify,
          tokenHash: Buffer.from(hashToken(rawToken), 'hex'),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          metadata: dto.returnTo ? { returnTo: dto.returnTo } : undefined,
        },
      });
      const accepted = documents.filter(
        (document) =>
          document.version === dto.acceptedTerms.termsVersion ||
          document.version === dto.acceptedTerms.privacyVersion ||
          document.version === dto.acceptedTerms.providerAgreementVersion,
      );
      await tx.legalAcceptance.createMany({
        data: accepted.map((document) => ({
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
    return { statusCode: 202, email, status: 'pending_verification' };
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
          data: {
            userId: user.id,
            purpose: AuthTokenPurpose.email_verify,
            tokenHash: Buffer.from(hashToken(rawToken), 'hex'),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
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

  async verifyEmail(dto: VerifyEmailDto) {
    const email = dto.email.toLowerCase().trim();
    const pendingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerifiedAt: true },
    });
    if (!pendingUser || pendingUser.emailVerifiedAt) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const codeConsumed = await this.redisAuth.consumeEmailVerificationCode(
      pendingUser.id,
      hashToken(dto.code),
    );
    if (!codeConsumed) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const verifiedAt = new Date();
    const user = await this.prisma.user.update({
      where: { id: pendingUser.id },
      data: {
        status: 'active',
        emailVerifiedAt: verifiedAt,
        lastLoginAt: verifiedAt,
      },
    });

    const tokenData = await this.redisAuth.generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      surfaces: this.surfacesForRole(user.role),
    });

    this.auditLogs.record({
      actorType: 'user',
      actorId: user.id,
      entityType: 'auth',
      entityId: user.id,
      action: 'email_verified',
    });

    try {
      await this.notifications.queueEmail({
        recipientEmail: user.email,
        recipientUserId: user.id,
        type: 'welcome',
        templateKey: 'welcome',
        payload: {
          firstName: user.firstName ?? 'there',
        },
      });
    } catch (error) {
      this.logger.error(
        `Welcome email enqueue failed userId=${user.id} error=${String(error)}`,
      );
    }

    return {
      verified: true,
      accessToken: tokenData.access,
      tokenType: 'Bearer',
      sessionId: tokenData.sessionId,
      expiresAt: tokenData.expiresAt,
      expiresIn: tokenData.expiresIn,
      userId: user.id,
      email: user.email,
      emailVerifiedAt: verifiedAt,
    };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        emailVerifiedAt: true,
      },
    });

    if (user && !user.emailVerifiedAt) {
      try {
        const verificationCode = generateNumericOtp(6);
        await this.redisAuth.storeEmailVerificationCode(
          user.id,
          hashToken(verificationCode),
        );
        await this.notifications.queueEmail({
          recipientEmail: user.email,
          recipientUserId: user.id,
          type: 'email_verification',
          templateKey: 'email_verification',
          payload: {
            code: verificationCode,
            firstName: user.firstName ?? undefined,
          },
        });
      } catch (error) {
        this.logger.error(
          `Verification resend failed userId=${user.id} error=${String(error)}`,
        );
      }
    }

    return {
      message:
        'If the account is awaiting verification, a new email will be sent',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { platformRoles: { select: { role: true } }, staffMember: { select: { status: true } } },
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
        staffStatus: user.staffMember?.status ?? null,
        emailVerified: !!user.emailVerifiedAt,
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
        onboardingCompleted: true,
        avatarUrl: true,
        language: true,
        timezone: true,
        notificationPreferences: true,
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
      staffStatus: user.staffMember?.status ?? null,
      emailVerified: !!user.emailVerifiedAt,
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
