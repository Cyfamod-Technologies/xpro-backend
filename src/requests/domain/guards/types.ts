import type { ActorView, RequestSnapshot } from '../snapshot';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'STATE_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'PAYMENT_IN_PROGRESS';

export type GuardFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422;
  code: ErrorCode;
  message: string;
};

export type GuardResult = { ok: true } | GuardFailure;

export type SettingsSnapshot = Readonly<Record<string, unknown>>;

export type DomainGuard<Input = unknown> = (
  snap: RequestSnapshot,
  actor: ActorView,
  input: Input | undefined,
  now: Date,
  settings: SettingsSnapshot,
) => GuardResult;
