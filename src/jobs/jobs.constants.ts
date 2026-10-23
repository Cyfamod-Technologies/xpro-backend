export const QUEUE_NAMES = [
  // email — NestJS publishes; consumed by EmailProcessor
  'email',
  // audit-logs — NestJS publishes; consumed by AuditLogsProcessor
  'audit-logs',
  // platform — NestJS schedules repeatable housekeeping; consumed by PlatformProcessor
  'platform',
  // outbox — NestJS kicks after commit and sweeps every 30 s; consumed by OutboxProcessor
  'outbox',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const OUTBOX_SWEEP_INTERVAL_MS = 30_000;
