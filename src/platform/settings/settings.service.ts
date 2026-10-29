import { Injectable } from '@nestjs/common';
import { Prisma, StaffRole, StaffStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { paginationArgs, toPaginatedResult } from '../../common/utils/paginate';
import { InboxService, InboxRowInput } from '../../notifications/inbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionStore } from '../../redis/session-store.service';
import {
  permissionsForRoles,
  StaffPermission,
} from '../../staff/staff-permissions';
import { ActorContext } from '../actor/actor.types';
import {
  requireActiveStaff,
  requireAnyPermission,
  requirePermission,
} from '../actor/actor.guards';
import { AppError } from '../errors/app-error';
import {
  getSettingDefinition,
  SETTINGS_REGISTRY,
  SettingKey,
} from './settings.registry';

export type SettingsChange = {
  key: string;
  value: unknown;
  expectedVersion: number;
};

export type SettingSnapshotItem = {
  key: SettingKey;
  value: unknown;
  version: number;
  riskClass: 'high' | 'operational';
  updatedBy: string | null;
  updatedAt: Date | null;
};

const validationError = (message: string, key?: string) =>
  new AppError(422, 'VALIDATION_ERROR', message, key ? { key } : undefined);
const formatSettingValue = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value === null
      ? 'off'
      : JSON.stringify(value);

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly inbox: InboxService,
    private readonly requestContext: RequestContextService,
    private readonly sessions: SessionStore,
  ) {}

  async snapshot(): Promise<SettingSnapshotItem[]> {
    const rows = await this.prisma.setting.findMany();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return Object.entries(SETTINGS_REGISTRY).map(([key, definition]) => {
      const row = byKey.get(key);
      return {
        key: key as SettingKey,
        value: row ? row.value : structuredClone(definition.defaultValue),
        version: row?.version ?? 1,
        riskClass: definition.riskClass,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async save(
    actor: ActorContext,
    changes: SettingsChange[],
    reason: string,
    reauthToken?: string,
    sessionId?: string,
    permission: StaffPermission = 'settings.manage',
  ) {
    requirePermission(actor, permission);
    if (
      !reason.trim() ||
      reason.trim().length < 5 ||
      reason.trim().length > 500
    )
      throw validationError('Add a reason for this change.');
    if (!actor.userId) throw new Error('A staff actor must have a user id');
    if (new Set(changes.map(({ key }) => key)).size !== changes.length)
      throw validationError(
        'A setting can only appear once in a change set.', // new message: not in spec
      );

    const prepared = changes.map((change) => {
      const definition = getSettingDefinition(change.key);
      if (!definition)
        throw validationError(
          'This setting is not available.', // new message: not in spec
          change.key,
        );
      const message = definition.validate(change.value);
      if (message) throw validationError(message, change.key);
      return {
        ...change,
        definition,
        value: change.value,
        jsonValue:
          change.value === null
            ? Prisma.JsonNull
            : (change.value as Prisma.InputJsonValue),
      };
    });
    const hasHighRisk = prepared.some(
      ({ definition }) => definition.riskClass === 'high',
    );
    const changeSetId = randomUUID();
    const ip = this.requestContext.getIp() ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const lockedKeys = [...prepared].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      for (const change of lockedKeys) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${change.key}, 0))`;
      }

      const oldValues = new Map<string, unknown>();
      for (const change of prepared) {
        const current = await tx.setting.findUnique({
          where: { key: change.key },
        });
        const version = current?.version ?? 1;
        if (version !== change.expectedVersion) {
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            'These settings changed since you opened them. Reload and try again.',
            { key: change.key },
          );
        }
        oldValues.set(
          change.key,
          current
            ? current.value
            : structuredClone(change.definition.defaultValue),
        );
      }

      if (
        hasHighRisk &&
        (!reauthToken ||
          !(await this.sessions.consumeReauthToken(actor.userId!, reauthToken)))
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Reauthenticate to continue.');
      }

      await Promise.all(
        prepared.map((change) =>
          tx.setting.upsert({
            where: { key: change.key },
            create: {
              key: change.key,
              value: change.jsonValue,
              riskClass: change.definition.riskClass,
              version: 2,
              updatedBy: actor.userId,
            },
            update: {
              value: change.jsonValue,
              riskClass: change.definition.riskClass,
              version: change.expectedVersion + 1,
              updatedBy: actor.userId,
            },
          }),
        ),
      );

      await tx.settingHistory.createMany({
        data: prepared.map((change) => ({
          key: change.key,
          oldValue:
            oldValues.get(change.key) === null
              ? Prisma.JsonNull
              : (oldValues.get(change.key) as Prisma.InputJsonValue),
          newValue: change.jsonValue,
          riskClass: change.definition.riskClass,
          actorId: actor.userId!,
          actorName: actor.displayName,
          reason: reason.trim(),
          changeSetId,
          sessionId,
          ip,
        })),
      });

      if (hasHighRisk) {
        const members = await tx.staffMember.findMany({
          where: { status: StaffStatus.active },
          select: { userId: true, roles: { select: { role: true } } },
        });
        const recipients = members
          .filter(({ userId, roles }) => {
            if (userId === actor.userId) return false;
            const roleNames = roles.map(({ role }) => role);
            const permissions = permissionsForRoles(roleNames);
            return (
              roleNames.includes(StaffRole.super_admin) ||
              (
                [
                  'bank.review',
                  'payment.record',
                  'payout.approve',
                  'refund.manage',
                ] as StaffPermission[]
              ).some((permission) => permissions.includes(permission))
            );
          })
          .map(({ userId }) => userId);
        const notificationRows: InboxRowInput[] = prepared
          .filter(({ definition }) => definition.riskClass === 'high')
          .flatMap((change) => {
            const oldValue = oldValues.get(change.key);
            const newValue = change.value;
            const title = `High-risk setting changed: ${change.definition.label}`;
            const message = `${actor.displayName} changed ${change.definition.label} from ${formatSettingValue(oldValue)} to ${formatSettingValue(newValue)}. Reason: ${reason.trim()}.`;
            return recipients.map((recipientId) => ({
              recipientId,
              event: `settings.high_risk_changed:${change.key}:${changeSetId}`,
              title,
              message,
              link: '/admin/settings/history',
              mandatory: true,
            }));
          });
        await this.inbox.createMany(tx, notificationRows);
      }

      return prepared.map((change) => ({
        key: change.key,
        before: oldValues.get(change.key),
        after: change.value,
        version: change.expectedVersion + 1,
        riskClass: change.definition.riskClass,
      }));
    });

    this.audit.record({
      actorType: 'staff',
      actorId: actor.userId,
      entityType: 'settings',
      action: 'settings.changed',
      metadata: {
        changeSetId,
        reason: reason.trim(),
        before: Object.fromEntries(
          result.map((item) => [item.key, item.before]),
        ),
        after: Object.fromEntries(result.map((item) => [item.key, item.after])),
      },
      ipAddress: ip,
    });
    return { changeSetId, changes: result };
  }

  async history(query: { key?: string; page: number; limit: number }) {
    const where: Prisma.SettingHistoryWhereInput = query.key
      ? { key: query.key }
      : {};
    const { skip, take } = paginationArgs(
      query.page,
      Math.min(query.limit, 100),
    );
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.settingHistory.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.settingHistory.count({ where }),
    ]);
    return toPaginatedResult(
      rows,
      total,
      query.page,
      Math.min(query.limit, 100),
    );
  }

  assertStaff(actor: ActorContext) {
    requireActiveStaff(actor);
  }

  assertHistoryPermission(actor: ActorContext) {
    requireAnyPermission(actor, ['settings.manage', 'view.audit_sensitive']);
  }
}
