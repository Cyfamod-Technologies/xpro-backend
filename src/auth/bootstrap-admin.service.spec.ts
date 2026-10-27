import {
  ConflictException,
  GoneException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BootstrapAdminConfig } from './bootstrap-admin.config';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';

describe('BootstrapAdminService', () => {
  const token = 'a'.repeat(64);
  const dto: BootstrapAdminDto = {
    firstName: 'Platform',
    lastName: 'Admin',
    password: 'A unique password 123!',
  };

  function setup(options?: {
    consumed?: boolean;
    existingAdmin?: boolean;
    existingEmail?: boolean;
  }) {
    const tx = {
      setting: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            options?.consumed ? { key: 'bootstrap.initial_super_admin' } : null,
          ),
        create: jest.fn().mockResolvedValue({}),
      },
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            options?.existingAdmin ? { id: 'existing' } : null,
          ),
        findUnique: jest
          .fn()
          .mockResolvedValue(
            options?.existingEmail ? { id: 'existing' } : null,
          ),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'admin-1', email: 'admin@xpro.test' }),
      },
      staffMemberRole: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const config: BootstrapAdminConfig = {
      email: 'admin@xpro.test',
      tokenSha256: createHash('sha256').update(token).digest('hex'),
    };
    const service = new BootstrapAdminService(
      prisma as unknown as PrismaService,
      config,
    );
    return { service, prisma, tx };
  }

  it('rejects short passwords before reaching the service', async () => {
    const errors = await validate(
      plainToInstance(BootstrapAdminDto, { ...dto, password: 'Password123!' }),
    );
    expect(errors.map((error) => error.property)).toContain('password');
  });

  it('rejects a missing token before touching the database', async () => {
    const { service, prisma } = setup();
    await expect(service.create(undefined, dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects the wrong token before touching the database', async () => {
    const { service, prisma } = setup();
    await expect(service.create('Bearer wrong', dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates the admin, permanent consumption record, and audit entry together', async () => {
    const { service, tx } = setup();
    await expect(service.create(`Bearer ${token}`, dto)).resolves.toEqual({
      id: 'admin-1',
      email: 'admin@xpro.test',
    });
    type CreateInput = {
      data: {
        passwordHash: string;
        passwordChangedAt: Date;
        emailVerifiedAt: Date;
      };
      select: { id: boolean; email: boolean };
    };
    const createCalls = tx.user.create.mock.calls as unknown as Array<
      [CreateInput]
    >;
    const createInput = createCalls[0][0];
    expect(createInput.data).toMatchObject({
      email: 'admin@xpro.test',
      firstName: 'Platform',
      lastName: 'Admin',
      role: 'super_admin',
      status: 'active',
      onboardingCompleted: true,
      platformRoles: {
        create: { role: 'staff', addedVia: 'invite' },
      },
      staffMember: {
        create: {
          status: 'active',
          roles: { create: { role: 'super_admin' } },
        },
      },
    });
    expect(createInput.data.passwordHash).not.toBe(dto.password);
    expect(createInput.data.passwordChangedAt).toBeInstanceOf(Date);
    expect(createInput.data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(createInput.select).toEqual({ id: true, email: true });
    expect(tx.setting.create).toHaveBeenCalledWith({
      data: {
        key: 'bootstrap.initial_super_admin',
        value: { userId: 'admin-1' },
        riskClass: 'high',
        updatedBy: 'admin-1',
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: 'system',
        entityType: 'user',
        entityId: 'admin-1',
        action: 'super_admin_bootstrapped',
      },
    });
  });

  it('refuses a second use without modifying an account', async () => {
    const { service, tx } = setup({ consumed: true });
    await expect(service.create(`Bearer ${token}`, dto)).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('treats a concurrent unique-key winner as consumed', async () => {
    const { service, tx } = setup();
    tx.setting.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.2',
      }),
    );
    await expect(service.create(`Bearer ${token}`, dto)).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it.each([{ existingAdmin: true }, { existingEmail: true }])(
    'refuses an existing privileged or matching account: %p',
    async (options) => {
      const { service, tx } = setup(options);
      await expect(
        service.create(`Bearer ${token}`, dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.user.create).not.toHaveBeenCalled();
    },
  );
});
