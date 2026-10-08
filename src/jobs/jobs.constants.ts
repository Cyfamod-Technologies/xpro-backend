export const QUEUE_NAMES = [
  // email — NestJS publishes; consumed by EmailProcessor
  'email',
  // audit-logs — NestJS publishes; consumed by AuditLogsProcessor
  'audit-logs',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
