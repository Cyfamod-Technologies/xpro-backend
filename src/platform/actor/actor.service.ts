import { Injectable } from '@nestjs/common';
import { StaffRole, StaffStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  canOwnRequests,
  permissionsForRoles,
} from '../../staff/staff-permissions';
import { AppError } from '../errors/app-error';
import type { ActorContext, ActorKind, ActorStaff } from './actor.types';

@Injectable()
export class ActorService {
  constructor(private readonly prisma: PrismaService) {}

  /** One query: the user, platform roles, staff member and staff roles. */
  async resolve(userId: string): Promise<ActorContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
        platformRoles: { select: { role: true } },
        staffMember: {
          select: {
            status: true,
            permVersion: true,
            roles: { select: { role: true } },
          },
        },
      },
    });
    if (!user)
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );

    const platformRoles = user.platformRoles.map(({ role }) => role);
    const member = platformRoles.includes('staff') ? user.staffMember : null;

    let staff: ActorStaff | undefined;
    if (member) {
      const roles = member.roles.map(({ role }) => role);
      const active = member.status === StaffStatus.active;
      staff = {
        status: member.status,
        roles,
        permissions: new Set(active ? permissionsForRoles(roles) : []),
        canOwn: canOwnRequests(member.status, roles),
        isSuperAdmin: active && roles.includes(StaffRole.super_admin),
        permVersion: member.permVersion,
      };
    }

    const kind: ActorKind = staff
      ? 'staff'
      : platformRoles.includes('provider')
        ? 'provider'
        : 'customer';
    const fullName = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      userId,
      kind,
      displayName: fullName || user.name || user.email,
      platformRoles,
      accountActive: user.status === 'active',
      staff,
    };
  }
}
