import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { SettingsService } from '../platform/settings/settings.service';
import { TimersService } from '../platform/timers/timers.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestDetailDto } from './dto/request-detail.dto';
import { customerProjection } from './projections/customer.projection';
import { providerProjection } from './projections/provider.projection';
import { staffProjection } from './projections/staff.projection';
import type { ProjectionContext } from './projections/projection.helpers';
import { formatEtag } from '../platform/concurrency/etag.util';
import { RequestSnapshotLoader } from './snapshot.loader';
import type { DispatchTrigger } from '@prisma/client';
import type { TimerKind } from '../platform/timers/timer-kinds';
import { mayAutoClaim } from './domain/auto-claim';

type AuditInput = {
  note?: string;
  changes?: unknown;
  flags?: string[];
  resourceType?: string;
  resourceId?: string;
};
type PendingNotification = { event: string; params: Record<string, unknown> };
type PendingTimerStart = { kind: TimerKind; dueAt: Date; refId?: string; payload?: object };
type CommandResult = void | { status?: number; changed?: boolean; warning?: string };

export type CommandContext = {
  tx: Prisma.TransactionClient;
  snap: Awaited<ReturnType<RequestSnapshotLoader['load']>> extends infer T
    ? Exclude<T, null>['snapshot'] : never;
  actor: ActorContext;
  now: Date;
  settings: Readonly<Record<string, unknown>>;
  audit(action: string, data?: AuditInput): void;
  notify(event: string, params: Record<string, unknown>): void;
  timers: {
    start(kind: TimerKind, dueAt: Date, refId?: string, payload?: object): void;
    stop(kind: TimerKind | TimerKind[], refId?: string): void;
  };
  enqueueCascade(trigger: DispatchTrigger): void;
};

@Injectable()
export class RequestCommandRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: RequestSnapshotLoader,
    private readonly settingsService: SettingsService,
    private readonly idempotency: IdempotencyService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly timersService: TimersService,
    private readonly outboxService: OutboxService,
  ) {}

  /** Execute the initial request submission through the same transaction and side-effect path as later commands. */
  async create(options: {
    actor: ActorContext;
    idempotencyKey: string;
    idempotencyHash: string;
  }, createRow: (tx: Prisma.TransactionClient, now: Date, settings: Readonly<Record<string, unknown>>) => Promise<string>, fn: (context: CommandContext) => Promise<CommandResult>): Promise<{
    status: number;
    body: RequestDetailDto;
    etag: string;
    warning?: string;
  }> {
    const { actor, idempotencyKey, idempotencyHash } = options;
    if (!actor.userId) throw new Error('Request creation requires an authenticated actor.');
    const existing = await this.idempotency.lookup(actor.userId, idempotencyKey, idempotencyHash);
    if (existing) {
      const body = existing.body as RequestDetailDto & { warning?: string };
      return { status: existing.status, body, etag: formatEtag(body.version), ...(body.warning ? { warning: body.warning } : {}) };
    }

    const now = new Date();
    const settings = Object.fromEntries((await this.settingsService.snapshot()).map(({ key, value }) => [key, value]));
    const notifications: PendingNotification[] = [];
    const auditRows: Array<{ action: string; data?: AuditInput }> = [];
    const timerStarts: PendingTimerStart[] = [];
    const timerStops: Array<{ kind: TimerKind | TimerKind[]; refId?: string }> = [];
    let cascadeTrigger: DispatchTrigger | undefined;
    let dueNowTimer = false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${idempotencyKey}`}, 0))`);
      const replay = await this.idempotency.lookup(actor.userId!, idempotencyKey, idempotencyHash, tx);
      if (replay) return { replay: { status: replay.status, body: replay.body as RequestDetailDto & { warning?: string } } };
      const id = await createRow(tx, now, settings);
      const loaded = await this.loader.load(tx, id, { forUpdate: true });
      if (!loaded) throw opaqueNotFound();
      const context: CommandContext = {
        tx,
        snap: loaded.snapshot,
        actor,
        now,
        settings,
        audit: (action, data) => auditRows.push({ action, data }),
        notify: (event, params) => notifications.push({ event, params }),
        timers: {
          start: (kind, dueAt, refId, payload) => {
            timerStarts.push({ kind, dueAt, refId, payload });
            if (dueAt <= now) dueNowTimer = true;
          },
          stop: (kind, refId) => timerStops.push({ kind, refId }),
        },
        enqueueCascade: (trigger) => { cascadeTrigger = trigger; },
      };
      const result = await fn(context);
      await this.flushEffects(tx, loaded.row.id, loaded.row.ownerId, actor, auditRows, notifications, timerStarts, timerStops, cascadeTrigger, now);
      const freshInTransaction = await this.loader.load(tx, loaded.row.id);
      if (!freshInTransaction) throw opaqueNotFound();
      const body = this.project(freshInTransaction.row, freshInTransaction.snapshot, actor, 'customer', now, settings);
      if (result?.warning) body.warning = result.warning;
      const status = result?.status ?? 201;
      await this.idempotency.store(actor.userId!, idempotencyKey, idempotencyHash, status, body, tx);
      return { status, id: loaded.row.id, role: 'customer' as const, warning: result?.warning, body };
    }, { timeout: 15_000 });

    if ('replay' in outcome) {
      const body = outcome.replay.body;
      return { status: outcome.replay.status, body, etag: formatEtag(body.version), ...(body.warning ? { warning: body.warning } : {}) };
    }

    if (dueNowTimer) await this.timersService.kick();
    if (notifications.length) await this.outboxService.kick();
    return { status: outcome.status, body: outcome.body, etag: formatEtag(outcome.body.version), ...(outcome.warning ? { warning: outcome.warning } : {}) };
  }

  async run(options: {
    command: string;
    actor: ActorContext;
    requestRef: string;
    expectedVersion?: number;
    idempotencyKey?: string;
    idempotencyHash?: string;
    autoClaim?: boolean;
  }, fn: (context: CommandContext) => Promise<CommandResult>): Promise<{
    status: number;
    body: RequestDetailDto;
    etag: string;
  }> {
    const { actor } = options;
    if (options.idempotencyKey) {
      if (!actor.userId || !options.idempotencyHash) {
        throw new Error('RequestCommandRunner requires an authenticated actor and request hash for idempotent commands.');
      }
      const existing = await this.idempotency.lookup(actor.userId, options.idempotencyKey, options.idempotencyHash);
      if (existing) return { status: existing.status, body: existing.body as RequestDetailDto, etag: formatEtag((existing.body as RequestDetailDto).version) };
    }

    const now = new Date();
    const settings = Object.fromEntries((await this.settingsService.snapshot()).map(({ key, value }) => [key, value]));
    const notifications: PendingNotification[] = [];
    const auditRows: Array<{ action: string; data?: AuditInput }> = [];
    const timerStarts: PendingTimerStart[] = [];
    const timerStops: Array<{ kind: TimerKind | TimerKind[]; refId?: string }> = [];
    let cascadeTrigger: DispatchTrigger | undefined;
    let dueNowTimer = false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      if (options.idempotencyKey && actor.userId && options.idempotencyHash) {
        await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${options.idempotencyKey}`}, 0))`);
        const replay = await this.idempotency.lookup(actor.userId, options.idempotencyKey, options.idempotencyHash, tx);
        if (replay) return { replay: { status: replay.status, body: replay.body as RequestDetailDto } };
      }
      const loaded = await this.loader.load(tx, options.requestRef, { forUpdate: true });
      if (!loaded) throw opaqueNotFound();
      const visibleRole = await this.visibleRole(loaded.snapshot, actor);
      if (!visibleRole) throw opaqueNotFound();

      if (options.expectedVersion !== undefined && options.expectedVersion !== loaded.row.version) {
        const current = this.project(loaded.row, loaded.snapshot, actor, visibleRole, now, settings);
        throw new AppError(409, 'VERSION_CONFLICT', 'This request has changed. Refresh and retry.', { current });
      }

      const context: CommandContext = {
        tx,
        snap: loaded.snapshot,
        actor,
        now,
        settings,
        audit: (action, data) => auditRows.push({ action, data }),
        notify: (event, params) => notifications.push({ event, params }),
        timers: {
          start: (kind, dueAt, refId, payload) => {
            timerStarts.push({ kind, dueAt, refId, payload });
            if (dueAt <= now) dueNowTimer = true;
          },
          stop: (kind, refId) => timerStops.push({ kind, refId }),
        },
        enqueueCascade: (trigger) => { cascadeTrigger = trigger; },
      };
      const result = await fn(context);
      if (result?.changed === false) {
        const status = result.status ?? 200;
        const body = this.project(loaded.row, loaded.snapshot, actor, visibleRole, now, settings);
        if (options.idempotencyKey && actor.userId && options.idempotencyHash) {
          await this.idempotency.store(actor.userId, options.idempotencyKey, options.idempotencyHash, status, body, tx);
        }
        return { status, body, changed: false };
      }
      await tx.serviceRequest.update({
        where: { id: loaded.row.id },
        data: { version: { increment: 1 }, updatedAt: now },
      });

      if (auditRows.length) {
        await tx.auditLog.createMany({
          data: auditRows.map(({ action, data }) => ({
            actorType: actor.kind,
            actorId: actor.userId,
            entityType: data?.resourceType ?? 'service_request',
            entityId: data?.resourceId ?? loaded.row.id,
            action,
            metadata: { ...(data ?? {}), requestId: loaded.row.id, command: options.command } as Prisma.InputJsonValue,
          })),
        });
      }
      for (const notification of notifications) {
        await this.dispatcher.dispatch(tx, notification.event, notification.params, {
          requestId: loaded.row.id,
          ownerId: loaded.row.ownerId,
          actorId: actor.userId,
        });
      }
      for (const start of timerStarts) {
        await this.timersService.start(tx, {
          requestId: loaded.row.id,
          kind: start.kind,
          dueAt: start.dueAt,
          refId: start.refId,
          payload: start.payload as Prisma.InputJsonValue | undefined,
        });
      }
      for (const stop of timerStops) {
        await this.timersService.stop(tx, {
          requestId: loaded.row.id,
          kinds: Array.isArray(stop.kind) ? stop.kind : [stop.kind],
          refId: stop.refId,
        });
      }
      if (options.autoClaim && mayAutoClaim(actor, options.command, loaded.row.staffOwnerId === null, isOpenRequestStatus(loaded.row.status))) {
        await this.autoClaim(tx, loaded.row, actor, now, options.command);
      }
      if (cascadeTrigger) {
        await this.timersService.start(tx, {
          requestId: loaded.row.id,
          kind: 'dispatch.cascade',
          dueAt: now,
          payload: { trigger: cascadeTrigger },
        });
        dueNowTimer = true;
      }
      const fresh = await this.loader.load(tx, loaded.row.id);
      if (!fresh) throw opaqueNotFound();
      const status = result?.status ?? 200;
      const body = this.project(fresh.row, fresh.snapshot, actor, visibleRole, now, settings);
      if (options.idempotencyKey && actor.userId && options.idempotencyHash) {
        await this.idempotency.store(actor.userId, options.idempotencyKey, options.idempotencyHash, status, body, tx);
      }
      return { status, body, changed: true };
    }, { timeout: 15_000 });

    if ('replay' in outcome) {
      return { status: outcome.replay.status, body: outcome.replay.body, etag: formatEtag(outcome.replay.body.version) };
    }
    if (outcome.changed && dueNowTimer) await this.timersService.kick();
    if (outcome.changed && notifications.length) await this.outboxService.kick();
    return { status: outcome.status, body: outcome.body, etag: formatEtag(outcome.body.version) };
  }

  private async visibleRole(snapshot: Exclude<Awaited<ReturnType<RequestSnapshotLoader['load']>>, null>['snapshot'], actor: ActorContext) {
    if (actor.kind === 'system') return 'staff' as const;
    if (actor.kind === 'staff' && actor.staff?.status === 'active') return 'staff' as const;
    if (actor.userId === snapshot.ownerId) return 'customer' as const;
    if (actor.platformRoles.includes('provider') && snapshot.accessibleProviderUserIds?.includes(actor.userId ?? '')) return 'provider' as const;
    return null;
  }

  private project(
    row: Exclude<Awaited<ReturnType<RequestSnapshotLoader['load']>>, null>['row'],
    snapshot: Exclude<Awaited<ReturnType<RequestSnapshotLoader['load']>>, null>['snapshot'],
    actor: ActorContext,
    role: 'customer' | 'provider' | 'staff',
    now: Date,
    settings: Readonly<Record<string, unknown>>,
  ): RequestDetailDto {
    const context: ProjectionContext = { row, snapshot, actor, role, now, settings };
    switch (role) {
      case 'customer': return customerProjection(context);
      case 'provider': return providerProjection(context);
      case 'staff': return staffProjection(context);
    }
  }

  private async autoClaim(
    tx: Prisma.TransactionClient,
    row: { id: string; status: string; staffOwnerId: string | null; ownershipVersion: number },
    actor: ActorContext,
    now: Date,
    command: string,
  ): Promise<void> {
    if (actor.kind !== 'staff' || !actor.userId || !actor.accountActive
      || actor.staff?.status !== 'active' || !actor.staff.canOwn || actor.staff.isSuperAdmin
      || row.staffOwnerId !== null || !isOpenRequestStatus(row.status)) return;

    const claimed = await tx.serviceRequest.updateMany({
      where: {
        id: row.id,
        staffOwnerId: null,
        ownershipVersion: row.ownershipVersion,
        status: { notIn: ['cancelled', 'rejected', 'closed'] },
      },
      data: {
        staffOwnerId: actor.userId,
        claimedAt: now,
        unclaimedSince: null,
        ownershipVersion: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return;

    await tx.auditLog.create({
      data: {
        actorType: actor.kind,
        actorId: actor.userId,
        entityType: 'service_request',
        entityId: row.id,
        action: 'request.auto_claimed',
        metadata: {
          requestId: row.id,
          command,
          before: { staffOwnerId: null },
          after: { staffOwnerId: actor.userId },
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async flushEffects(
    tx: Prisma.TransactionClient,
    requestId: string,
    ownerId: string,
    actor: ActorContext,
    auditRows: Array<{ action: string; data?: AuditInput }>,
    notifications: PendingNotification[],
    timerStarts: PendingTimerStart[],
    timerStops: Array<{ kind: TimerKind | TimerKind[]; refId?: string }>,
    cascadeTrigger: DispatchTrigger | undefined,
    now: Date,
  ): Promise<void> {
    if (auditRows.length) await tx.auditLog.createMany({
      data: auditRows.map(({ action, data }) => ({
        actorType: actor.kind,
        actorId: actor.userId,
        entityType: data?.resourceType ?? 'service_request',
        entityId: data?.resourceId ?? requestId,
        action,
        metadata: { ...(data ?? {}), requestId, command: 'request.create' } as Prisma.InputJsonValue,
      })),
    });
    for (const notification of notifications) {
      await this.dispatcher.dispatch(tx, notification.event, notification.params, { requestId, ownerId, actorId: actor.userId });
    }
    for (const start of timerStarts) await this.timersService.start(tx, {
      requestId, kind: start.kind, dueAt: start.dueAt, refId: start.refId,
      payload: start.payload as Prisma.InputJsonValue | undefined,
    });
    for (const stop of timerStops) await this.timersService.stop(tx, {
      requestId, kinds: Array.isArray(stop.kind) ? stop.kind : [stop.kind], refId: stop.refId,
    });
    if (cascadeTrigger) await this.timersService.start(tx, {
      requestId, kind: 'dispatch.cascade', dueAt: now, payload: { trigger: cascadeTrigger },
    });
  }
}

function opaqueNotFound() {
  return new AppError(404, 'NOT_FOUND', 'This request is no longer available to your account.');
}

function isOpenRequestStatus(status: string): boolean {
  return status !== 'cancelled' && status !== 'rejected' && status !== 'closed';
}
