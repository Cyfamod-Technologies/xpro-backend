import type { RequestTimer } from '@prisma/client';
import { SYSTEM_ACTOR } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import type { ActorContext } from '../platform/actor/actor.types';
import { toActorView } from './actor-view';
import type { RequestCommandRunner } from './command-runner';
import type { CommandContext } from './command-runner';
import { REQUEST_GUARDS } from './domain/request-guard-registry';
import type { RequestSnapshot } from './domain/snapshot';

type SystemFn = Parameters<RequestCommandRunner['runSystem']>[2];
type InTxFn = Parameters<RequestCommandRunner['runInTx']>[2];
type RunOptions = {
  command: string;
  actor: ActorContext;
  guard?: string | null;
  input?: unknown;
};
type RunFn = Parameters<RequestCommandRunner['run']>[1];

export type RecordedEffects = {
  audit: Array<{ action: string; data?: unknown }>;
  notify: Array<{ event: string; params: Record<string, unknown> }>;
  timerStarts: Array<{
    kind: string;
    dueAt: Date;
    refId?: string;
    payload?: object;
  }>;
  timerStops: Array<{ kind: string | string[]; refId?: string }>;
  approvalOpens: Array<{ kind: string; itemId: string }>;
  approvalCloses: Array<{ kind: string; itemId: string; reason?: string }>;
  cascades: string[];
};

export type RecordedRun = {
  command: string;
  requestRef: string;
  opts?: { actor?: unknown; bumpVersion?: boolean };
  result: { changed: boolean };
};

/**
 * A stand-in for `RequestCommandRunner` that runs the handler against a
 * recording context. It reports `{ changed: false }` exactly as the real
 * runner does, so a test can assert that a stale timer writes nothing.
 */
export function systemCommandKit(
  options: {
    snap?: Partial<RequestSnapshot>;
    tx?: unknown;
    settings?: Record<string, unknown>;
    now?: Date;
  } = {},
) {
  const effects: RecordedEffects = {
    audit: [],
    notify: [],
    timerStarts: [],
    timerStops: [],
    approvalOpens: [],
    approvalCloses: [],
    cascades: [],
  };
  const runs: RecordedRun[] = [];
  const now = options.now ?? new Date('2026-10-24T12:00:00.000Z');
  const ctx = {
    tx: options.tx ?? {},
    snap: {
      id: 'request-1',
      number: 'XPR-00042',
      status: 'under_review',
      intake: { state: 'approved' },
      pendingUpdates: [],
      openIssues: [],
      hold: null,
      districtName: 'Ikeja',
      ...options.snap,
    } as unknown as RequestSnapshot,
    actor: SYSTEM_ACTOR,
    now,
    settings: options.settings ?? {},
    audit: (action: string, data?: unknown) =>
      effects.audit.push({ action, data }),
    notify: (event: string, params: Record<string, unknown>) =>
      effects.notify.push({ event, params }),
    timers: {
      start: (kind: string, dueAt: Date, refId?: string, payload?: object) =>
        effects.timerStarts.push({ kind, dueAt, refId, payload }),
      stop: (kind: string | string[], refId?: string) =>
        effects.timerStops.push({ kind, refId }),
    },
    approvals: {
      open: (kind: string, itemId: string) =>
        effects.approvalOpens.push({ kind, itemId }),
      close: (kind: string, itemId: string, reason?: string) =>
        effects.approvalCloses.push({ kind, itemId, reason }),
    },
    enqueueCascade: (trigger: string) => effects.cascades.push(trigger),
  } as unknown as CommandContext;

  const runner = {
    /** Applies the registry guard exactly as the real runner does before the handler runs. */
    run: async (options: RunOptions, fn: RunFn) => {
      const key = options.guard === undefined ? options.command : options.guard;
      if (key !== null) {
        const guard = REQUEST_GUARDS[key];
        if (!guard)
          throw new Error(`No request guard is registered for "${key}".`);
        const result = guard(
          ctx.snap,
          toActorView(options.actor),
          options.input,
          now,
          ctx.settings,
        );
        if (!result.ok)
          throw new AppError(result.status, result.code, result.message);
      }
      const outcome = await fn(ctx);
      runs.push({
        command: options.command,
        requestRef: '',
        result: { changed: outcome?.changed !== false },
      });
      return { status: 200, body: {}, etag: 'W/"1"' };
    },
    runSystem: async (
      command: string,
      requestRef: string,
      fn: SystemFn,
      opts?: RecordedRun['opts'],
    ) => {
      const result = { changed: (await fn(ctx))?.changed !== false };
      runs.push({ command, requestRef, opts, result });
      return result;
    },
    runInTx: async (
      _tx: unknown,
      options: { command: string; requestRef: string },
      fn: InTxFn,
    ) => {
      const changed = (await fn(ctx))?.changed !== false;
      runs.push({
        command: options.command,
        requestRef: options.requestRef,
        result: { changed },
      });
      return {
        status: 200,
        body: {},
        etag: 'W/"1"',
        changed,
        afterCommit: () => Promise.resolve(),
      };
    },
  } as unknown as RequestCommandRunner;

  return { runner, ctx, effects, runs };
}

export function timerFixture(
  kind: string,
  overrides: Partial<RequestTimer> = {},
): RequestTimer {
  return {
    id: 'timer-1',
    requestId: 'request-1',
    kind,
    refId: '',
    dueAt: new Date('2026-10-24T12:00:00.000Z'),
    payload: null,
    status: 'running',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    firedAt: null,
    createdAt: new Date('2026-10-20T12:00:00.000Z'),
    ...overrides,
  };
}
