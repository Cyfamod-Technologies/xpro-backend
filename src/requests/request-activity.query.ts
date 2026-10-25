import { Prisma } from '@prisma/client';

export type ActivityRow = {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
};

/** Raw SQL so the filter matches the `audit_logs_request_id` expression index; the request id is always a bound parameter. */
export function activityRowsSql(
  requestId: string,
  skip: number,
  take: number,
): Prisma.Sql {
  return Prisma.sql`SELECT id, action, actor_type AS "actorType", actor_id AS "actorId", created_at AS "createdAt", metadata FROM audit_logs WHERE metadata->>'requestId' = ${requestId} ORDER BY created_at DESC, id DESC LIMIT ${take} OFFSET ${skip}`;
}

export function activityCountSql(requestId: string): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::int AS total FROM audit_logs WHERE metadata->>'requestId' = ${requestId}`;
}
