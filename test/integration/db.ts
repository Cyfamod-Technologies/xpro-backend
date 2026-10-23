import type { PrismaClient } from '@prisma/client';

/** Tables owned by request-flow work packages. Add each new table here as it is introduced. */
export const REQUEST_TABLES = [
  'idempotency_keys',
  'in_app_notifications',
  'outbox_events',
  'request_timers',
  'settings_history',
  'settings',
];

export async function truncateRequestTables(prisma: PrismaClient) {
  const list = REQUEST_TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
