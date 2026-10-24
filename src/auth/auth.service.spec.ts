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
  ) => {
    const user = { id: 'user-1', email: payload.email };
    const tx = {
      user: { create: jest.fn().mockResolvedValue(user) },
      authToken: { create: jest.fn().mockResolvedValue({}) },
      legalAcceptance: {
        createMany: jest.fn().mockResolvedValue({ count: documents.length }),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      legalDocument: {
        findMany: jest.fn((_query: { where: { publishedAt: { lte: Date } } }) =>
          Promise.resolve(documents),
        ),
      },
      $transaction: jest.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const notifications = { queueEmail: jest.fn().mockResolvedValue({}) };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditLogsService,
      notifications as unknown as NotificationsService,
      {} as RedisAuthService,
      {} as SessionStore,
    );

    return { service, prisma, tx, notifications };
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
});
