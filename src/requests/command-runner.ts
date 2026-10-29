import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SYSTEM_ACTOR, type ActorContext } from '../platform/actor/actor.types';
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
import { REQUEST_GUARDS } from './domain/request-guard-registry';
import type { RequestSnapshot } from './domain/snapshot';
import { toActorView } from './actor-view';
import { ApprovalsHooks } from './approvals.hooks';

type AuditInput = {
  note?: string;
  changes?: unknown;
  flags?: string[];
  resourceType?: string;
  resourceId?: string;
};
type PendingNotification = { event: string; params: Record<string, unknown> };
type Effect =
  | {
      type: 'timer.start';
      kind: TimerKind;
      dueAt: Date;
      refId?: string;
      payload?: object;
    }
  | { type: 'timer.stop'; kind: TimerKind | TimerKind[]; refId?: string }
  | { type: 'approval.open'; kind: string; itemId: string }
  | { type: 'approval.close'; kind: string; itemId: string; reason?: string };
/** Everything a command buffers until its transaction flushes. `effects` keeps timer and approval operations in call order. */
type EffectBuffer = {
  notifications: PendingNotification[];
  auditRows: Array<{ action: string; data?: AuditInput }>;
  effects: Effect[];
  cascadeTrigger?: DispatchTrigger;
  dueNowTimer: boolean;
};
type EffectTarget = {
  requestId: string;
  ownerId: string;
  /** The staff owner as loaded before the command ran and before any auto-claim (02 §6.5). */
  staffOwnerId: string | null;
  actor: ActorContext;
  command: string;
  now: Date;
};
/** The `REQUEST_GUARDS` entry a command runs under (default: the command key) and the body its guard may check. */
type GuardOptions = {
  /** `null` skips the guard; only for system commands and domain events that make their own checks. */
  guard?: string | null;
  input?: unknown;
};
type ExecuteOptions = GuardOptions & {
  command: string;
  actor: ActorContext;
  requestRef: string;
  expectedVersion?: number;
  autoClaim?: boolean;
  /** Set to `false` for commands that change no request row (reminders). Default `true`. */
  bumpVersion?: boolean;
};
type ExecuteOutcome = {
  status: number;
  body: RequestDetailDto;
  changed: boolean;
  dueNowTimer: boolean;
  notified: boolean;
};

/** Thrown inside a system transaction to roll it back when the handler reports `{ changed: false }`. */
class NoChange extends Error {}

type CommandResult = void | {
  status?: number;
  changed?: boolean;
  warning?: string;
  /** Overrides the option for this run, for handlers that only sometimes change a request row. */
  bumpVersion?: boolean;
};

export type CommandContext = {
  tx: Prisma.TransactionClient;
  snap: RequestSnapshot;
  actor: ActorContext;
  now: Date;
  settings: Readonly<Record<string, unknown>>;
  audit(action: string, data?: AuditInput): void;
  notify(event: string, params: Record<string, unknown>): void;
  timers: {
    start(kind: TimerKind, dueAt: Date, refId?: string, payload?: object): void;
    stop(kind: TimerKind | TimerKind[], refId?: string): void;
  };
  /** Approval deadlines are opened and closed in the same ordered list as timers. */
  approvals: {
    open(kind: string, itemId: string): void;
    close(kind: string, itemId: string, reason?: string): void;
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
    private readonly approvalsHooks: ApprovalsHooks,
  ) {}

  /** Execute the initial request submission through the same transaction and side-effect path as later commands. */
  async create(
    options: {
      actor: ActorContext;
      idempotencyKey: string;
      idempotencyHash: string;
    },
    createRow: (
      tx: Prisma.TransactionClient,
      now: Date,
      settings: Readonly<Record<string, unknown>>,
    ) => Promise<string>,
    fn: (context: CommandContext) => Promise<CommandResult>,
  ): Promise<{
    status: number;
    body: RequestDetailDto;
    etag: string;
    warning?: string;
  }> {
    const { actor, idempotencyKey, idempotencyHash } = options;
    if (!actor.userId)
      throw new Error('Request creation requires an authenticated actor.');
    const existing = await this.idempotency.lookup(
      actor.userId,
      idempotencyKey,
      idempotencyHash,
    );
    if (existing) {
      const body = existing.body as RequestDetailDto & { warning?: string };
      return {
        status: existing.status,
        body,
        etag: formatEtag(body.version),
        ...(body.warning ? { warning: body.warning } : {}),
      };
    }

    const now = new Date();
    const settings = Object.fromEntries(
      (await this.settingsService.snapshot()).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    const buffer = newBuffer();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${idempotencyKey}`}, 0))`,
        );
        const replay = await this.idempotency.lookup(
          actor.userId!,
          idempotencyKey,
          idempotencyHash,
          tx,
        );
        if (replay)
          return {
            replay: {
              status: replay.status,
              body: replay.body as RequestDetailDto & { warning?: string },
            },
          };
        const id = await createRow(tx, now, settings);
        const loaded = await this.loader.load(tx, id, { forUpdate: true });
        if (!loaded) throw opaqueNotFound();
        const context = this.buildContext(
          tx,
          loaded.snapshot,
          actor,
          now,
          settings,
          buffer,
        );
        const result = await fn(context);
        await this.flushEffects(
          tx,
          {
            requestId: loaded.row.id,
            ownerId: loaded.row.ownerId,
            staffOwnerId: loaded.row.staffOwnerId,
            actor,
            command: 'request.create',
            now,
          },
          buffer,
        );
        await this.startCascade(tx, loaded.row.id, buffer, now);
        const freshInTransaction = await this.loader.load(tx, loaded.row.id);
        if (!freshInTransaction) throw opaqueNotFound();
        const body = this.project(
          freshInTransaction.row,
          freshInTransaction.snapshot,
          actor,
          'customer',
          now,
          settings,
        );
        if (result?.warning) body.warning = result.warning;
        const status = result?.status ?? 201;
        await this.idempotency.store(
          actor.userId!,
          idempotencyKey,
          idempotencyHash,
          status,
          body,
          tx,
        );
        return {
          status,
          id: loaded.row.id,
          role: 'customer' as const,
          warning: result?.warning,
          body,
        };
      },
      { timeout: 15_000 },
    );

    if (outcome.replay) {
      const { status, body } = outcome.replay;
      return {
        status,
        body,
        etag: formatEtag(body.version),
        ...(body.warning ? { warning: body.warning } : {}),
      };
    }

    if (buffer.dueNowTimer) await this.timersService.kick();
    if (buffer.notifications.length) await this.outboxService.kick();
    return {
      status: outcome.status,
      body: outcome.body,
      etag: formatEtag(outcome.body.version),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    };
  }

  async run(
    options: GuardOptions & {
      command: string;
      actor: ActorContext;
      requestRef: string;
      expectedVersion?: number;
      idempotencyKey?: string;
      idempotencyHash?: string;
      autoClaim?: boolean;
    },
    fn: (context: CommandContext) => Promise<CommandResult>,
  ): Promise<{
    status: number;
    body: RequestDetailDto;
    etag: string;
  }> {
    const { actor } = options;
    if (options.idempotencyKey) {
      if (!actor.userId || !options.idempotencyHash) {
        throw new Error(
          'RequestCommandRunner requires an authenticated actor and request hash for idempotent commands.',
        );
      }
      const existing = await this.idempotency.lookup(
        actor.userId,
        options.idempotencyKey,
        options.idempotencyHash,
      );
      if (existing)
        return {
          status: existing.status,
          body: existing.body as RequestDetailDto,
          etag: formatEtag((existing.body as RequestDetailDto).version),
        };
    }

    const now = new Date();
    const settings = await this.settingsMap();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        if (options.idempotencyKey && actor.userId && options.idempotencyHash) {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${options.idempotencyKey}`}, 0))`,
          );
          const replay = await this.idempotency.lookup(
            actor.userId,
            options.idempotencyKey,
            options.idempotencyHash,
            tx,
          );
          if (replay)
            return {
              replay: {
                status: replay.status,
                body: replay.body as RequestDetailDto,
              },
            };
        }
        const executed = await this.execute(tx, options, fn, now, settings);
        if (options.idempotencyKey && actor.userId && options.idempotencyHash) {
          await this.idempotency.store(
            actor.userId,
            options.idempotencyKey,
            options.idempotencyHash,
            executed.status,
            executed.body,
            tx,
          );
        }
        return { executed };
      },
      { timeout: 15_000 },
    );

    if (outcome.replay) {
      const { status, body } = outcome.replay;
      return {
        status,
        body,
        etag: formatEtag(body.version),
      };
    }
    const { executed } = outcome;
    await this.kickAfterCommit(executed);
    return {
      status: executed.status,
      body: executed.body,
      etag: formatEtag(executed.body.version),
    };
  }

  /**
   * Run a timer or domain-event command as the system (or the dispatch engine,
   * via `opts.actor`). There is no `If-Match` and no idempotency key. Reminder
   * handlers that write no request row pass `opts.bumpVersion: false` so the
   * version (and the ETag) stays put; their notifications still flush. When `fn`
   * returns `{ changed: false }` the whole transaction is rolled back, so
   * nothing is written: no version bump, audit rows, notifications, timers or
   * approval deadlines. The rollback works by throwing a private sentinel
   * inside the transaction and catching it outside.
   */
  async runSystem(
    command: string,
    requestRef: string,
    fn: (context: CommandContext) => Promise<CommandResult>,
    opts?: { actor?: ActorContext; bumpVersion?: boolean },
  ): Promise<{ changed: boolean; version?: number }> {
    const now = new Date();
    const settings = await this.settingsMap();
    let executed: ExecuteOutcome;
    try {
      executed = await this.prisma.$transaction(
        async (tx) => {
          const result = await this.execute(
            tx,
            {
              command,
              actor: opts?.actor ?? SYSTEM_ACTOR,
              requestRef,
              bumpVersion: opts?.bumpVersion,
              // Timers and engine jobs decide for themselves whether they still apply.
              guard: null,
            },
            fn,
            now,
            settings,
          );
          if (!result.changed) throw new NoChange();
          return result;
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      if (error instanceof NoChange) return { changed: false };
      throw error;
    }
    await this.kickAfterCommit(executed);
    return { changed: true, version: executed.body.version };
  }

  /**
   * Same steps as `run()` (lock, visibility, version check, `fn`, version bump,
   * effects flush, auto-claim, cascade) inside the caller's transaction, so a
   * money row and the request transition commit together. It opens no
   * transaction and has no idempotency. A `{ changed: false }` result skips the
   * bump and the flush, but cannot undo writes `fn` already made on `tx`, so
   * `fn` must not write before deciding nothing changed. Call the returned
   * `afterCommit()` once the outer transaction has committed to kick the timer
   * sweeper and the outbox.
   */
  async runInTx(
    tx: Prisma.TransactionClient,
    options: ExecuteOptions,
    fn: (context: CommandContext) => Promise<CommandResult>,
  ): Promise<{
    status: number;
    body: RequestDetailDto;
    etag: string;
    changed: boolean;
    afterCommit: () => Promise<void>;
  }> {
    const now = new Date();
    const settings = await this.settingsMap();
    const executed = await this.execute(tx, options, fn, now, settings);
    return {
      status: executed.status,
      body: executed.body,
      etag: formatEtag(executed.body.version),
      changed: executed.changed,
      afterCommit: () => this.kickAfterCommit(executed),
    };
  }

  private async settingsMap(): Promise<Readonly<Record<string, unknown>>> {
    return Object.fromEntries(
      (await this.settingsService.snapshot()).map(({ key, value }) => [
        key,
        value,
      ]),
    );
  }

  private async kickAfterCommit(executed: ExecuteOutcome): Promise<void> {
    if (!executed.changed) return;
    if (executed.dueNowTimer) await this.timersService.kick();
    if (executed.notified) await this.outboxService.kick();
  }

  private async execute(
    tx: Prisma.TransactionClient,
    options: ExecuteOptions,
    fn: (context: CommandContext) => Promise<CommandResult>,
    now: Date,
    settings: Readonly<Record<string, unknown>>,
  ): Promise<ExecuteOutcome> {
    const { actor } = options;
    const loaded = await this.loader.load(tx, options.requestRef, {
      forUpdate: true,
    });
    if (!loaded) throw opaqueNotFound();
    const visibleRole = this.visibleRole(loaded.snapshot, actor);
    if (!visibleRole) throw opaqueNotFound();
    const current = () =>
      this.project(
        loaded.row,
        loaded.snapshot,
        actor,
        visibleRole,
        now,
        settings,
      );

    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== loaded.row.version
    ) {
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'This request has changed. Refresh and retry.',
        { current: current() },
      );
    }

    this.enforceGuard(options, loaded.snapshot, now, settings, current);

    const buffer = newBuffer();
    const context = this.buildContext(
      tx,
      loaded.snapshot,
      actor,
      now,
      settings,
      buffer,
    );
    let result: CommandResult;
    try {
      result = await fn(context);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.getStatus() === 409 &&
        !error.details
      ) {
        throw new AppError(409, error.code, error.message, {
          current: current(),
        });
      }
      throw error;
    }
    if (result?.changed === false) {
      return {
        status: result.status ?? 200,
        body: current(),
        changed: false,
        dueNowTimer: false,
        notified: false,
      };
    }
    if (result?.bumpVersion ?? options.bumpVersion ?? true)
      await tx.serviceRequest.update({
        where: { id: loaded.row.id },
        data: { version: { increment: 1 }, updatedAt: now },
      });
    await this.flushEffects(
      tx,
      {
        requestId: loaded.row.id,
        ownerId: loaded.row.ownerId,
        staffOwnerId: loaded.row.staffOwnerId,
        actor,
        command: options.command,
        now,
      },
      buffer,
    );
    if (
      options.autoClaim &&
      mayAutoClaim(
        actor,
        options.command,
        loaded.row.staffOwnerId === null,
        isOpenRequestStatus(loaded.row.status),
        options.input,
      )
    ) {
      await this.autoClaim(tx, loaded.row, actor, now, options.command);
    }
    await this.startCascade(tx, loaded.row.id, buffer, now);
    const fresh = await this.loader.load(tx, loaded.row.id);
    if (!fresh) throw opaqueNotFound();
    return {
      status: result?.status ?? 200,
      body: this.project(
        fresh.row,
        fresh.snapshot,
        actor,
        visibleRole,
        now,
        settings,
      ),
      changed: true,
      dueNowTimer: buffer.dueNowTimer,
      notified: buffer.notifications.length > 0,
    };
  }

  /** 04 §2.1: one registry guard per command, after the lock, visibility and version checks and before the handler. */
  private enforceGuard(
    options: ExecuteOptions,
    snapshot: RequestSnapshot,
    now: Date,
    settings: Readonly<Record<string, unknown>>,
    current: () => RequestDetailDto,
  ): void {
    const key = options.guard === undefined ? options.command : options.guard;
    if (key === null) return;
    const guard = REQUEST_GUARDS[key];
    if (!guard)
      throw new Error(
        `No request guard is registered for "${key}". Add it to REQUEST_GUARDS, or pass guard: null for a command that makes its own checks.`,
      );
    const result = guard(
      snapshot,
      toActorView(options.actor),
      options.input,
      now,
      settings,
    );
    if (result.ok) return;
    throw new AppError(
      result.status,
      result.code,
      result.message,
      result.status === 409 ? { current: current() } : undefined,
    );
  }

  private buildContext(
    tx: Prisma.TransactionClient,
    snap: RequestSnapshot,
    actor: ActorContext,
    now: Date,
    settings: Readonly<Record<string, unknown>>,
    buffer: EffectBuffer,
  ): CommandContext {
    return {
      tx,
      snap,
      actor,
      now,
      settings,
      audit: (action, data) => buffer.auditRows.push({ action, data }),
      notify: (event, params) => buffer.notifications.push({ event, params }),
      timers: {
        start: (kind, dueAt, refId, payload) => {
          buffer.effects.push({
            type: 'timer.start',
            kind,
            dueAt,
            refId,
            payload,
          });
          if (dueAt <= now) buffer.dueNowTimer = true;
        },
        stop: (kind, refId) =>
          buffer.effects.push({ type: 'timer.stop', kind, refId }),
      },
      approvals: {
        open: (kind, itemId) =>
          buffer.effects.push({ type: 'approval.open', kind, itemId }),
        close: (kind, itemId, reason) =>
          buffer.effects.push({ type: 'approval.close', kind, itemId, reason }),
      },
      enqueueCascade: (trigger) => {
        buffer.cascadeTrigger = trigger;
      },
    };
  }

  private visibleRole(
    snapshot: Exclude<
      Awaited<ReturnType<RequestSnapshotLoader['load']>>,
      null
    >['snapshot'],
    actor: ActorContext,
  ) {
    if (actor.kind === 'system') return 'staff' as const;
    if (actor.kind === 'staff' && actor.staff?.status === 'active')
      return 'staff' as const;
    if (actor.userId === snapshot.ownerId) return 'customer' as const;
    if (
      actor.platformRoles.includes('provider') &&
      snapshot.accessibleProviderUserIds?.includes(actor.userId ?? '')
    )
      return 'provider' as const;
    return null;
  }

  private project(
    row: Exclude<
      Awaited<ReturnType<RequestSnapshotLoader['load']>>,
      null
    >['row'],
    snapshot: Exclude<
      Awaited<ReturnType<RequestSnapshotLoader['load']>>,
      null
    >['snapshot'],
    actor: ActorContext,
    role: 'customer' | 'provider' | 'staff',
    now: Date,
    settings: Readonly<Record<string, unknown>>,
  ): RequestDetailDto {
    const context: ProjectionContext = {
      row,
      snapshot,
      actor,
      role,
      now,
      settings,
    };
    switch (role) {
      case 'customer':
        return customerProjection(context);
      case 'provider':
        return providerProjection(context);
      case 'staff':
        return staffProjection(context);
    }
  }

  private async autoClaim(
    tx: Prisma.TransactionClient,
    row: {
      id: string;
      status: string;
      staffOwnerId: string | null;
      ownershipVersion: number;
    },
    actor: ActorContext,
    now: Date,
    command: string,
  ): Promise<void> {
    if (
      actor.kind !== 'staff' ||
      !actor.userId ||
      !actor.accountActive ||
      actor.staff?.status !== 'active' ||
      !actor.staff.canOwn ||
      actor.staff.isSuperAdmin ||
      row.staffOwnerId !== null ||
      !isOpenRequestStatus(row.status)
    )
      return;

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
    await this.approvalsHooks.close(
      tx,
      'unclaimed',
      row.id,
      now,
      'auto_claimed',
    );

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
        },
      },
    });
  }

  private async flushEffects(
    tx: Prisma.TransactionClient,
    target: EffectTarget,
    buffer: EffectBuffer,
  ): Promise<void> {
    const { requestId, ownerId, staffOwnerId, actor, command, now } = target;
    if (buffer.auditRows.length)
      await tx.auditLog.createMany({
        data: buffer.auditRows.map(({ action, data }) => ({
          actorType: actor.kind,
          actorId: actor.userId,
          entityType: data?.resourceType ?? 'service_request',
          entityId: data?.resourceId ?? requestId,
          action,
          metadata: {
            ...(data ?? {}),
            requestId,
            command,
          } as Prisma.InputJsonValue,
        })),
      });
    for (const notification of buffer.notifications) {
      await this.dispatcher.dispatch(
        tx,
        notification.event,
        notification.params,
        { requestId, ownerId, staffOwnerId, actorId: actor.userId },
      );
    }
    for (const effect of buffer.effects) {
      switch (effect.type) {
        case 'timer.start':
          await this.timersService.start(tx, {
            requestId,
            kind: effect.kind,
            dueAt: effect.dueAt,
            refId: effect.refId,
            payload: effect.payload,
          });
          break;
        case 'timer.stop':
          await this.timersService.stop(tx, {
            requestId,
            kinds: Array.isArray(effect.kind) ? effect.kind : [effect.kind],
            refId: effect.refId,
          });
          break;
        case 'approval.open':
          await this.approvalsHooks.open(
            tx,
            effect.kind,
            effect.itemId,
            requestId,
            now,
            actor.userId,
          );
          break;
        case 'approval.close':
          await this.approvalsHooks.close(
            tx,
            effect.kind,
            effect.itemId,
            now,
            effect.reason,
          );
          break;
      }
    }
  }

  private async startCascade(
    tx: Prisma.TransactionClient,
    requestId: string,
    buffer: EffectBuffer,
    now: Date,
  ): Promise<void> {
    if (!buffer.cascadeTrigger) return;
    await this.timersService.start(tx, {
      requestId,
      kind: 'dispatch.cascade',
      dueAt: now,
      payload: { trigger: buffer.cascadeTrigger },
    });
    buffer.dueNowTimer = true;
  }
}

function newBuffer(): EffectBuffer {
  return {
    notifications: [],
    auditRows: [],
    effects: [],
    dueNowTimer: false,
  };
}

function opaqueNotFound() {
  return new AppError(
    404,
    'NOT_FOUND',
    'This request is no longer available to your account.',
  );
}

function isOpenRequestStatus(status: string): boolean {
  return status !== 'cancelled' && status !== 'rejected' && status !== 'closed';
}
