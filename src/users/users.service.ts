import { Injectable } from '@nestjs/common';
import { AccountStatus, AppRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertInvitedUser(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    role?: AppRole;
  }) {
    return this.prisma.user.upsert({
      where: { email: input.email.toLowerCase() },
      update: {
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
      },
      create: {
        email: input.email.toLowerCase(),
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        status: AccountStatus.invited,
      },
    });
  }

  async createActiveUser(input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    role?: AppRole;
  }) {
    return this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: await bcrypt.hash(input.password, 10),
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        status: AccountStatus.active,
      },
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
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
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }
}
