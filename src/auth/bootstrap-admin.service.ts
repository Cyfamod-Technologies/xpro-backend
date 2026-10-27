import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, RoleAddedVia } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  BOOTSTRAP_ADMIN_CONFIG,
  BootstrapAdminConfig,
} from './bootstrap-admin.config';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';

const BOOTSTRAP_KEY = 'bootstrap.initial_super_admin';

@Injectable()
export class BootstrapAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BOOTSTRAP_ADMIN_CONFIG)
    private readonly config: BootstrapAdminConfig,
  ) {}

  async create(authorization: string | undefined, dto: BootstrapAdminDto) {
    const suppliedToken = authorization?.match(/^Bearer (\S+)$/i)?.[1] ?? '';
    const expectedHash = Buffer.from(this.config.tokenSha256, 'hex');
    const suppliedHash = createHash('sha256').update(suppliedToken).digest();
    if (!timingSafeEqual(expectedHash, suppliedHash)) {
      throw new UnauthorizedException('Invalid bootstrap token');
    }

    const email = this.config.email;
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    if (!firstName || !lastName) {
      throw new BadRequestException('A first and last name are required.');
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const existingBootstrap = await tx.setting.findUnique({
          where: { key: BOOTSTRAP_KEY },
          select: { key: true },
        });
        if (existingBootstrap)
          throw new GoneException('Bootstrap already used.');

        const [existingAdmin, existingStaffAdmin, existingEmail] =
          await Promise.all([
            tx.user.findFirst({
              where: { role: 'super_admin' },
              select: { id: true },
            }),
            tx.staffMemberRole.findFirst({
              where: { role: 'super_admin' },
              select: { staffUserId: true },
            }),
            tx.user.findUnique({
              where: { email },
              select: { id: true },
            }),
          ]);
        if (existingAdmin || existingStaffAdmin) {
          throw new ConflictException('A super admin already exists.');
        }
        if (existingEmail) {
          throw new ConflictException('The bootstrap email already exists.');
        }

        const created = await tx.user.create({
          data: {
            email,
            firstName,
            lastName,
            passwordHash,
            passwordChangedAt: new Date(),
            role: 'super_admin',
            status: 'active',
            emailVerifiedAt: new Date(),
            onboardingCompleted: true,
            platformRoles: {
              create: { role: 'staff', addedVia: RoleAddedVia.invite },
            },
            staffMember: {
              create: {
                status: 'active',
                roles: { create: { role: 'super_admin' } },
              },
            },
          },
          select: { id: true, email: true },
        });
        await tx.setting.create({
          data: {
            key: BOOTSTRAP_KEY,
            value: { userId: created.id },
            riskClass: 'high',
            updatedBy: created.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            entityType: 'user',
            entityId: created.id,
            action: 'super_admin_bootstrapped',
          },
        });
        return created;
      });
      return { id: user.id, email: user.email };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new GoneException('Bootstrap already used or account exists.');
      }
      throw error;
    }
  }
}
