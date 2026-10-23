import { Injectable } from '@nestjs/common';
import { Prisma, StaffRole, StaffStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  canOwnRequests,
  permissionsForRoles,
  type StaffPermission,
} from '../staff/staff-permissions';

/** 02 §6.8: 1 gated on a request, 2 gated off-request, 3 informational, 4 pricing, 5 customer messages. */
export type StaffRoutingRule =
  'gated' | 'gated_unscoped' | 'informational' | 'unclaimed' | 'pricing' | 'customer_message';

export type StaffRoutingInput = {
  requestId?: string | null;
  ownerId: string | null;
  /** The deciding permission for rules 1 and 2; ignored by the others. */
  permission?: StaffPermission;
  actorId: string | null;
};

type ActiveMember = { userId: string; roles: StaffRole[] };

/**
 * Subscriptions to customer conversations are not stored yet; 02 §6.15 makes
 * them default-on for Client relations, so that preset stands in.
 */
const CUSTOMER_CONVERSATION_ROLES: readonly StaffRole[] = [
  StaffRole.client_relations,
];

const ALL_ROLES = Object.values(StaffRole);

@Injectable()
export class StaffRoutingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Distinct user ids, never including the actor. Leave and delegates are not modelled yet. */
  async audience(
    rule: StaffRoutingRule,
    input: StaffRoutingInput,
  ): Promise<string[]> {
    const recipients = await this.resolve(rule, input);
    return [...new Set(recipients)].filter((id) => id !== input.actorId);
  }

  private async resolve(
    rule: StaffRoutingRule,
    input: StaffRoutingInput,
  ): Promise<string[]> {
    const owner = input.ownerId ? await this.activeMember(input.ownerId) : null;

    switch (rule) {
      case 'gated': {
        const permission = this.requirePermission(input);
        if (owner && this.holds(owner.roles, permission)) return [owner.userId];
        return [
          ...(owner ? [owner.userId] : []),
          ...(await this.holders(permission, input.actorId)),
        ];
      }
      case 'gated_unscoped':
        return this.holders(this.requirePermission(input), input.actorId);
      case 'informational':
        if (owner) return [owner.userId];
        return this.membersWhoCanOwn();
      case 'unclaimed':
        return [
          ...(await this.membersWhoCanOwn()),
          ...(await this.holders('request.clarify', input.actorId)),
        ];
      case 'pricing':
        return [
          ...(owner ? [owner.userId] : []),
          ...(await this.holders('quote.manage', input.actorId)),
        ];
      case 'customer_message': {
        const holders = await this.activeMembers('message.customer');
        return [
          ...(owner ? [owner.userId] : []),
          ...holders
            .filter((member) =>
              member.roles.some((role) =>
                CUSTOMER_CONVERSATION_ROLES.includes(role),
              ),
            )
            .map((member) => member.userId),
        ];
      }
    }
  }

  /**
   * Rule 6, computed over members other than the actor: members whose only
   * source of the permission is `super_admin` are left out unless nobody else
   * holds it.
   */
  private async holders(
    permission: StaffPermission,
    actorId: string | null,
  ): Promise<string[]> {
    const members = (await this.activeMembers(permission)).filter(
      (member) => member.userId !== actorId,
    );
    const ordinary = members.filter((member) =>
      this.heldWithoutSuperAdmin(member.roles, permission),
    );
    return (ordinary.length > 0 ? ordinary : members).map(
      (member) => member.userId,
    );
  }

  private holds(roles: StaffRole[], permission: StaffPermission) {
    return permissionsForRoles(roles).includes(permission);
  }

  private heldWithoutSuperAdmin(
    roles: StaffRole[],
    permission: StaffPermission,
  ) {
    return this.holds(
      roles.filter((role) => role !== StaffRole.super_admin),
      permission,
    );
  }

  private requirePermission(input: StaffRoutingInput): StaffPermission {
    if (!input.permission) {
      throw new Error(
        'A deciding permission is required for this routing rule',
      );
    }
    return input.permission;
  }

  private async activeMember(userId: string): Promise<ActiveMember | null> {
    const members = await this.queryMembers({ userId });
    return members[0] ?? null;
  }

  private async activeMembers(
    permission: StaffPermission,
  ): Promise<ActiveMember[]> {
    const grantingRoles = ALL_ROLES.filter((role) =>
      permissionsForRoles([role]).includes(permission),
    );
    const members = await this.queryMembers({
      roles: { some: { role: { in: grantingRoles } } },
    });
    return members.filter((member) => this.holds(member.roles, permission));
  }

  private async membersWhoCanOwn(): Promise<string[]> {
    const members = await this.queryMembers({});
    return members
      .filter((member) => canOwnRequests(StaffStatus.active, member.roles))
      .map((member) => member.userId);
  }

  private async queryMembers(
    where: Prisma.StaffMemberWhereInput,
  ): Promise<ActiveMember[]> {
    const rows = await this.prisma.staffMember.findMany({
      where: {
        ...where,
        status: StaffStatus.active,
        user: {
          status: 'active',
          platformRoles: { some: { role: 'staff' } },
        },
      },
      select: { userId: true, roles: { select: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      roles: row.roles.map(({ role }) => role),
    }));
  }
}
