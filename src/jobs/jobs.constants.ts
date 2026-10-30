export const QUEUE_NAMES = [
  'sms',
  // email — NestJS publishes; consumed by EmailProcessor
  'email',
  // audit-logs — NestJS publishes; consumed by AuditLogsProcessor
  'audit-logs',
  // platform — NestJS schedules repeatable housekeeping; consumed by PlatformProcessor
  'platform',
  // outbox — NestJS kicks after commit and sweeps every 30 s; consumed by OutboxProcessor
  'outbox',
  // timers — NestJS kicks after commit and sweeps every 60 s; consumed by TimersProcessor
  'timers',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const OUTBOX_SWEEP_INTERVAL_MS = 30_000;

export const TIMERS_SWEEP_INTERVAL_MS = 60_000;

export const UPLOAD_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
