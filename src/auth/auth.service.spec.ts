import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionStore } from '../redis/session-store.service';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/auth.dto';
import type { RedisAuthService } from './redis-auth.service';

describe('AuthService registration legal documents', () => {
  const payload: RegisterDto = {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    password: 'StrongPassword123!',
    role: 'customer',
  };

  const setup = (
    documents: { id: string; kind: 'terms' | 'privacy'; version: string }[],
    existing: Record<string, unknown> | null = null,
  ) => {
    const user = { id: 'user-1', email: payload.email };
    const tx = {
      user: {
        create: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      userRole: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      authToken: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      legalAcceptance: {
        createMany: jest.fn().mockResolvedValue({ count: documents.length }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(existing) },
      authToken: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      legalDocument: {
        findMany: jest.fn((_query: { where: { publishedAt: { lte: Date } } }) =>
          Promise.resolve(documents),
        ),
      },
      $transaction: jest.fn(
        (
          input: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[],
        ) => (Array.isArray(input) ? Promise.all(input) : input(tx)),
      ),
    };
    const notifications = { queueEmail: jest.fn().mockResolvedValue({}) };
    const auditLogs = { record: jest.fn() };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      auditLogs as unknown as AuditLogsService,
      notifications as unknown as NotificationsService,
      {} as RedisAuthService,
      {} as SessionStore,
    );

    return { service, prisma, tx, notifications, auditLogs };
  };

  it('validates registration without acceptedTerms', async () => {
    const errors = await validate(plainToInstance(RegisterDto, payload));

    expect(errors).toEqual([]);
  });

  it('registers without acceptance when no legal documents are published', async () => {
    const { service, prisma, tx, notifications } = setup([]);

    await expect(service.register(payload)).resolves.toEqual({
      statusCode: 202,
      email: payload.email,
      status: 'pending_verification',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      prisma.legalDocument.findMany.mock.calls[0][0].where.publishedAt.lte,
    ).toBeInstanceOf(Date);
    expect(tx.legalAcceptance.createMany).not.toHaveBeenCalled();
    expect(notifications.queueEmail).toHaveBeenCalledTimes(1);
  });

  it('accepts the version of each document that is published', async () => {
    const { service, tx } = setup([
      { id: 'terms-1', kind: 'terms', version: 'v1' },
    ]);

    await service.register({
      ...payload,
      acceptedTerms: { termsVersion: 'v1' },
    });

    expect(tx.legalAcceptance.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', documentId: 'terms-1', source: 'signup' }],
    });
  });

  it('rejects registration when a published document is not accepted', async () => {
    const { service, prisma } = setup([
      { id: 'terms-1', kind: 'terms', version: 'v1' },
    ]);

    await expect(service.register(payload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('existing accounts', () => {
    const response = {
      statusCode: 202,
      email: payload.email,
      status: 'pending_verification',
    };
    const existingUser = (overrides: Record<string, unknown> = {}) => ({
      id: 'user-9',
      email: payload.email,
      firstName: 'Ada',
      name: null,
      status: 'active',
      deletionScheduledFor: null,
      staffMember: null,
      ...overrides,
    });

    it('emails an active account owner and changes nothing', async () => {
      const { service, tx, notifications } = setup([], existingUser());

      await expect(service.register(payload)).resolves.toEqual(response);
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(notifications.queueEmail).toHaveBeenCalledTimes(1);
      expect(notifications.queueEmail).toHaveBeenCalledWith({
        recipientEmail: payload.email,
        recipientUserId: 'user-9',
        type: 'account_exists',
        templateKey: 'account_exists',
        payload: { firstName: 'Ada' },
        cooldown: { key: 'account_exists:user-9', seconds: 600 },
      });
    });

    it('emails a suspended account owner', async () => {
      const { service, notifications } = setup(
        [],
        existingUser({ status: 'suspended' }),
      );

      await expect(service.register(payload)).resolves.toEqual(response);
      expect(notifications.queueEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateKey: 'account_exists' }),
      );
    });

    it('includes the deletion date for an account pending deletion', async () => {
      const { service, notifications } = setup(
        [],
        existingUser({
          status: 'pending_deletion',
          deletionScheduledFor: new Date('2026-11-20T10:00:00.000Z'),
        }),
      );

      await expect(service.register(payload)).resolves.toEqual(response);
      expect(notifications.queueEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          templateKey: 'account_exists',
          payload: {
            firstName: 'Ada',
            deletionScheduledFor: '2026-11-20T10:00:00.000Z',
          },
        }),
      );
    });

    it.each(['invited', 'active', 'suspended'])(
      'emails the staff notice for a %s staff member',
      async (staffStatus) => {
        const { service, tx, notifications } = setup(
          [],
          existingUser({ staffMember: { status: staffStatus } }),
        );

        await expect(service.register(payload)).resolves.toEqual(response);
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(notifications.queueEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'staff_account_exists',
            templateKey: 'staff_account_exists',
            payload: { firstName: 'Ada' },
            cooldown: { key: 'account_exists:user-9', seconds: 600 },
          }),
        );
      },
    );

    it.each(['deactivated', 'revoked'])(
      'sends nothing for a %s staff member',
      async (staffStatus) => {
        const { service, notifications } = setup(
          [],
          existingUser({ staffMember: { status: staffStatus } }),
        );

        await expect(service.register(payload)).resolves.toEqual(response);
        expect(notifications.queueEmail).not.toHaveBeenCalled();
      },
    );

    it('checks the staff record before the user status', async () => {
      const { service, tx, notifications } = setup(
        [],
        existingUser({
          status: 'unverified',
          staffMember: { status: 'invited' },
        }),
      );

      await expect(service.register(payload)).resolves.toEqual(response);
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(notifications.queueEmail).toHaveBeenCalledWith(
        expect.objectContaining({ templateKey: 'staff_account_exists' }),
      );
    });

    it.each(['inactive', 'deactivated', 'deleted', 'archived', 'invited'])(
      'sends nothing for a %s account',
      async (status) => {
        const { service, tx, notifications } = setup(
          [],
          existingUser({ status }),
        );

        await expect(service.register(payload)).resolves.toEqual(response);
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(notifications.queueEmail).not.toHaveBeenCalled();
      },
    );

    it('replaces an unverified signup and sends a new verification email', async () => {
      const { service, prisma, tx, notifications, auditLogs } = setup(
        [{ id: 'terms-1', kind: 'terms', version: 'v1' }],
        existingUser({ status: 'unverified' }),
      );

      await expect(
        service.register({
          ...payload,
          firstName: ' Grace ',
          lastName: 'Hopper',
          role: 'provider',
          returnTo: '/request',
          acceptedTerms: { termsVersion: 'v1' },
        }),
      ).resolves.toEqual(response);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-9' },
        data: {
          firstName: 'Grace',
          lastName: 'Hopper',
          passwordHash: expect.any(String) as string,
        },
      });
      expect(tx.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-9' },
      });
      expect(tx.userRole.create).toHaveBeenCalledWith({
        data: { userId: 'user-9', role: 'provider', addedVia: 'signup' },
      });
      expect(tx.legalAcceptance.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-9' },
      });
      expect(tx.legalAcceptance.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'user-9', documentId: 'terms-1', source: 'signup' }],
      });
      expect(tx.authToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-9', purpose: 'email_verify', usedAt: null },
        data: { usedAt: expect.any(Date) as Date },
      });
      expect(tx.authToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-9',
          purpose: 'email_verify',
          metadata: { returnTo: '/request' },
        }) as object,
      });
      expect(notifications.queueEmail).toHaveBeenCalledTimes(1);
      expect(notifications.queueEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: 'user-9',
          type: 'email_verification',
          templateKey: 'email_verification',
          payload: {
            token: expect.any(String) as string,
            firstName: 'Grace',
          },
        }),
      );
      expect(
        (notifications.queueEmail.mock.calls as unknown[][])[0][0],
      ).not.toHaveProperty('cooldown');
      expect(auditLogs.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'signup_replaced' }),
      );
    });

    it('rejects stale legal versions even when the email is registered', async () => {
      const { service, notifications } = setup(
        [{ id: 'terms-1', kind: 'terms', version: 'v1' }],
        existingUser(),
      );

      await expect(
        service.register({
          ...payload,
          acceptedTerms: { termsVersion: 'v0' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(notifications.queueEmail).not.toHaveBeenCalled();
    });
  });

  describe('resendEmailVerification', () => {
    const unverified = {
      id: 'user-9',
      email: payload.email,
      name: null,
      firstName: 'Ada',
      emailVerifiedAt: null,
      status: 'unverified',
    };

    it('keeps the latest returnTo on the new token', async () => {
      const { service, prisma, notifications } = setup([], unverified);
      prisma.authToken.findFirst.mockResolvedValue({
        metadata: { returnTo: '/request' },
      });

      await service.resendEmailVerification({ email: payload.email });

      expect(prisma.authToken.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
      expect(prisma.authToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { returnTo: '/request' },
        }) as object,
      });
      expect(notifications.queueEmail).toHaveBeenCalledTimes(1);
    });

    it('creates a token without metadata when there was no returnTo', async () => {
      const { service, prisma } = setup([], unverified);

      await service.resendEmailVerification({ email: payload.email });

      expect(prisma.authToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata: undefined }) as object,
      });
    });
  });
});

describe('AuthService roles', () => {
  const setup = (account: {
    status?: string;
    roles: string[];
    staff?: boolean;
    agreement?: { id: string; version: string } | null;
  }) => {
    const row = {
      status: account.status ?? 'active',
      platformRoles: account.roles.map((role) => ({ role })),
      staffMember: account.staff ? { status: 'active' } : null,
    };
    const tx = {
      userRole: { create: jest.fn().mockResolvedValue({}) },
      legalAcceptance: { create: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
      },
      legalDocument: {
        findFirst: jest.fn().mockResolvedValue(account.agreement ?? null),
      },
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const audit = { record: jest.fn() };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogsService,
      {} as NotificationsService,
      {} as RedisAuthService,
      {} as SessionStore,
    );
    const me = jest
      .spyOn(service, 'me')
      .mockResolvedValue({ id: 'user-1' } as Awaited<
        ReturnType<AuthService['me']>
      >);
    return { service, prisma, tx, audit, me };
  };

  it('adds the customer role to a provider and makes it active', async () => {
    const { service, tx, audit, me } = setup({ roles: ['provider'] });

    await service.addRole('user-1', { role: 'customer' });

    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', role: 'customer', addedVia: 'self_service' },
    });
    expect(tx.legalAcceptance.create).not.toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { lastActiveRole: 'customer' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.role_added' }),
    );
    expect(me).toHaveBeenCalledWith('user-1');
  });

  it('records the provider agreement when a customer becomes a provider', async () => {
    const { service, tx } = setup({
      roles: ['customer'],
      agreement: { id: 'doc-pa', version: 'v2' },
    });

    await service.addRole('user-1', {
      role: 'provider',
      acceptedTerms: { providerAgreementVersion: 'v2' },
    });

    expect(tx.legalAcceptance.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', documentId: 'doc-pa', source: 'role_added' },
    });
  });

  it('refuses the provider role without the current agreement', async () => {
    const { service, tx } = setup({
      roles: ['customer'],
      agreement: { id: 'doc-pa', version: 'v2' },
    });

    await expect(
      service.addRole('user-1', {
        role: 'provider',
        acceptedTerms: { providerAgreementVersion: 'v1' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.userRole.create).not.toHaveBeenCalled();
  });

  it('refuses a role the account already holds', async () => {
    const { service } = setup({ roles: ['customer'] });

    await expect(
      service.addRole('user-1', { role: 'customer' }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('refuses staff and inactive accounts', async () => {
    await expect(
      setup({ roles: ['staff'], staff: true }).service.addRole('user-1', {
        role: 'customer',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      setup({ roles: ['provider'], status: 'suspended' }).service.addRole(
        'user-1',
        { role: 'customer' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('switches the active role only to a role the account holds', async () => {
    const both = setup({ roles: ['customer', 'provider'] });
    await both.service.setActiveRole('user-1', 'customer');
    expect(both.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { lastActiveRole: 'customer' },
    });

    const provider = setup({ roles: ['provider'] });
    await expect(
      provider.service.setActiveRole('user-1', 'customer'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(provider.prisma.user.update).not.toHaveBeenCalled();
  });
});
