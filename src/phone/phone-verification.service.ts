import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { normalizeAccountPhone } from '../common/utils/phone.util';
import { encryptSecret } from '../common/utils/crypto.util';
import { JobsService } from '../jobs/jobs.service';
import { AppError } from '../platform/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

const MINUTE = 60_000;
const EXPIRED = 'This code has expired. Request a new one.';

@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
    private readonly jobs: JobsService,
    private readonly audit: AuditLogsService,
  ) {}

  async start(userId: string, input: string) {
    const phone = normalizeAccountPhone(input);
    if (!phone)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Enter a valid Nigerian phone number.',
      );
    this.sms.requireConfigured();
    const now = new Date();
    const id = randomUUID();
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(now.getTime() + 10 * MINUTE);
    const resendAfter = new Date(now.getTime() + MINUTE);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      // Serialise the per-number limit across accounts without storing the number in a lock key.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phone}, 0))`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'active')
        throw new UnauthorizedException('Authentication failed');
      if (user.phoneE164 === phone && user.phoneVerifiedAt)
        throw new AppError(
          409,
          'STATE_CONFLICT',
          'This phone number is already verified.',
        );

      const recent = await tx.phoneVerification.findMany({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * MINUTE) },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, phoneE164: true },
      });
      const lastSent = recent[0]?.createdAt.getTime();
      if (lastSent && now.getTime() - lastSent < MINUTE)
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Wait before requesting another code.',
          {
            resendAfter: new Date(lastSent + MINUTE).toISOString(),
          },
        );
      if (
        recent.filter(
          (row) => now.getTime() - row.createdAt.getTime() < 60 * MINUTE,
        ).length >= 5
      )
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Too many codes requested. Try again in an hour.',
        );
      if (
        !recent.some((row) => row.phoneE164 === phone) &&
        new Set(recent.map((row) => row.phoneE164)).size >= 3
      )
        throw new AppError(
          429,
          'RATE_LIMITED',
          'You can verify up to three different numbers per day.',
        );
      const sends = await tx.phoneVerification.count({
        where: {
          phoneE164: phone,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * MINUTE) },
        },
      });
      if (sends >= 10)
        throw new AppError(
          429,
          'RATE_LIMITED',
          'This number has reached its daily code limit. Try again tomorrow.',
        );

      await tx.phoneVerification.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.phoneVerification.create({
        data: {
          id,
          userId,
          phoneE164: phone,
          codeHash: this.hash(id, code),
          expiresAt,
        },
      });
      if (user.phoneE164 !== phone)
        await tx.user.update({
          where: { id: userId },
          data: { phoneE164: phone, phoneVerifiedAt: null },
        });
    });

    try {
      await this.jobs.addSmsJob({
        verificationId: id,
        encryptedCode: encryptSecret(code),
      });
    } catch {
      await this.prisma.phoneVerification.updateMany({
        where: { id, userId },
        data: { consumedAt: new Date() },
      });
      throw new ServiceUnavailableException(
        'Phone verification is temporarily unavailable. Try again later.',
      );
    }
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'phone_verification',
      entityId: id,
      action: 'account.phone.verification_sent',
    });
    return {
      verificationId: id,
      phone: `${phone.slice(0, 4)} ••• ••• ${phone.slice(-4)}`,
      expiresAt: expiresAt.toISOString(),
      resendAfter: resendAfter.toISOString(),
    };
  }

  async confirm(userId: string, verificationId: string, code: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const now = new Date();
      const verification = await tx.phoneVerification.findFirst({
        where: { id: verificationId, userId },
      });
      if (
        !verification ||
        verification.consumedAt ||
        verification.expiresAt <= now ||
        verification.attempts >= 5
      )
        return { error: EXPIRED } as const;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'active')
        throw new UnauthorizedException('Authentication failed');
      if (user.phoneE164 !== verification.phoneE164)
        return { error: EXPIRED } as const;
      const valid = timingSafeEqual(
        Buffer.from(verification.codeHash, 'hex'),
        Buffer.from(this.hash(verificationId, code), 'hex'),
      );
      const attempts = verification.attempts + 1;
      await tx.phoneVerification.update({
        where: { id: verificationId },
        data: {
          attempts,
          ...(valid || attempts >= 5 ? { consumedAt: now } : {}),
        },
      });
      // Returning an error commits the failed attempt; throwing inside would roll it back.
      if (!valid)
        return {
          error: attempts >= 5 ? EXPIRED : 'That code is incorrect.',
        } as const;
      await tx.user.update({
        where: { id: userId },
        data: { phoneE164: verification.phoneE164, phoneVerifiedAt: now },
      });
      // Older provider projections still read this snapshot; account verification remains authoritative.
      await tx.providerProfile.updateMany({
        where: { userId },
        data: { phone: verification.phoneE164, version: { increment: 1 } },
      });
      return {
        phone: verification.phoneE164,
        phoneVerified: true,
        phoneVerifiedAt: now.toISOString(),
      };
    });
    if (result.error !== undefined)
      throw new AppError(422, 'VALIDATION_ERROR', result.error);
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'phone_verification',
      entityId: verificationId,
      action: 'account.phone.verified',
    });
    return result;
  }

  private hash(id: string, code: string) {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('ENCRYPTION_KEY'),
    )
      .update(`${id}:${code}`)
      .digest('hex');
  }
}
