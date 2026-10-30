import { Prisma } from '@prisma/client';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import {
  CHANNEL_PERMISSION,
  CURRENT_ASSIGNMENTS,
  type MessageChannelName,
} from './messages.service';

export const CONVERSATION_PREVIEW_LENGTH = 140;

const CHANNEL_ORDER: readonly MessageChannelName[] = [
  'customer',
  'provider',
  'internal',
];

/**
 * The channels a staff member may read, by `message.*` permission (04 §6.20).
 * Empty for anyone who is not an active staff member.
 */
export function readableChannels(actor: ActorContext): MessageChannelName[] {
  if (actor.kind !== 'staff' || actor.staff?.status !== 'active') return [];
  const { permissions } = actor.staff;
  return CHANNEL_ORDER.filter((channel) =>
    permissions.has(CHANNEL_PERMISSION[channel]),
  );
}

export type ConversationCursor = { at: Date; number: number };

const BAD_CURSOR =
  'This page of conversations is no longer valid. Reload the list.';

function badCursor() {
  return new AppError(422, 'VALIDATION_ERROR', BAD_CURSOR);
}

/** `(lastMessageAt, request number)` of the last row on a page, as an opaque string. */
export function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.at.toISOString(), n: cursor.number }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): ConversationCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw badCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (parsed === null || typeof parsed !== 'object') throw badCursor();
  const { t, n } = parsed as { t?: unknown; n?: unknown };
  if (typeof t !== 'string' || typeof n !== 'number') throw badCursor();
  const at = new Date(t);
  if (
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== t ||
    !Number.isSafeInteger(n) ||
    n < 1
  )
    throw badCursor();
  return { at, number: n };
}

/** Escapes `\`, `%` and `_` so user text is matched literally by ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function searchPattern(query: string): string {
  return `%${escapeLike(query)}%`;
}

/** `42`, `0042`, `xpr-42` and `XPR-00042` all name request number 42. */
export function requestNumberFromQuery(query: string): number | null {
  const match = /^(?:xpr-?)?(\d{1,9})$/i.exec(query.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

/**
 * Single-line preview of a message: whitespace collapsed, cut near `max`
 * characters at a word boundary when one is close enough, with an ellipsis.
 */
export function previewText(
  text: string,
  max = CONVERSATION_PREVIEW_LENGTH,
): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const characters = [...flat];
  if (characters.length <= max) return flat;
  const head = characters.slice(0, max).join('');
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace >= max * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

export type ConversationSqlInput = {
  channels: readonly MessageChannelName[];
  /** Trimmed search text, or undefined for no search. */
  q?: string;
};

const SEARCH_COLUMNS = [
  Prisma.sql`('XPR-' || lpad(r.number::text, 5, '0'))`,
  Prisma.sql`r.title`,
  Prisma.sql`r.description`,
  Prisma.sql`r.service`,
  Prisma.sql`cs.name`,
  Prisma.sql`csr.name`,
  Prisma.sql`city.name`,
  Prisma.sql`district.name`,
  Prisma.sql`r.customer_name`,
  Prisma.sql`pp.business_name`,
];

function channelPredicate(channels: readonly MessageChannelName[]): Prisma.Sql {
  const parts = channels.map((channel) =>
    channel === 'provider'
      ? // Only the current assignment's thread; earlier providers are left out.
        Prisma.sql`(m.channel = 'provider' AND m.provider_id = e.current_provider_id)`
      : channel === 'customer'
        ? Prisma.sql`m.channel = 'customer'`
        : Prisma.sql`m.channel = 'internal'`,
  );
  return parts.length
    ? Prisma.join(parts, ' OR ')
    : // Callers refuse before querying; this keeps the SQL valid and empty.
      Prisma.sql`FALSE`;
}

function searchClause(q: string | undefined): {
  joins: Prisma.Sql;
  where: Prisma.Sql;
} {
  if (!q) return { joins: Prisma.empty, where: Prisma.empty };
  const pattern = searchPattern(q);
  const number = requestNumberFromQuery(q);
  const matches = SEARCH_COLUMNS.map(
    (column) => Prisma.sql`${column} ILIKE ${pattern} ESCAPE '\\'`,
  );
  if (number !== null) matches.push(Prisma.sql`r.number = ${number}`);
  return {
    joins: Prisma.sql`
      LEFT JOIN catalog_services cs ON cs.id = r.service_id
      LEFT JOIN catalog_services csr ON csr.id = r.service_root_id
      LEFT JOIN locations city ON city.id = r.city_id
      LEFT JOIN locations district ON district.id = r.district_id
      LEFT JOIN provider_profiles pp ON pp.id = cur.provider_id`,
    where: Prisma.sql`WHERE (${Prisma.join(matches, ' OR ')})`,
  };
}

/**
 * The shared CTE chain. Every request id and text value is a bound parameter.
 *
 * - `eligible`: every request the staff member may see (active staff see all
 *   requests, as in `RequestsReadService.canSee`), narrowed by `q`, with the
 *   current provider taken like `MessagesService.currentAssignment`: the latest
 *   assignment, only if its status is still current.
 * - `readable`: the messages on channels the viewer may read.
 * - `last_msg`: the newest readable message per request (`DISTINCT ON`).
 * - `waiting`: customer or provider messages newer than the newest staff
 *   message among the readable ones.
 */
function conversationCtes(input: ConversationSqlInput): Prisma.Sql {
  const search = searchClause(input.q);
  return Prisma.sql`
    WITH eligible AS (
      SELECT r.id, r.number, r.status, r.title, r.staff_owner_id,
             r.customer_name, cur.provider_id AS current_provider_id
      FROM service_requests r
      LEFT JOIN LATERAL (
        SELECT CASE WHEN a.status::text = ANY(${[...CURRENT_ASSIGNMENTS]})
                    THEN a.provider_id END AS provider_id
        FROM assignments a
        WHERE a.request_id = r.id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1
      ) cur ON TRUE
      ${search.joins}
      ${search.where}
    ),
    readable AS (
      SELECT m.request_id, m.id, m.channel, m.author_id, m.author_role,
             m.text, m.created_at
      FROM request_messages m
      JOIN eligible e ON e.id = m.request_id
      WHERE (${channelPredicate(input.channels)})
    ),
    last_msg AS (
      SELECT DISTINCT ON (request_id)
             request_id, id, channel, author_id, author_role, text, created_at
      FROM readable
      ORDER BY request_id, created_at DESC, id DESC
    ),
    last_staff AS (
      SELECT request_id, max(created_at) AS staff_at
      FROM readable
      WHERE author_role = 'staff'
      GROUP BY request_id
    ),
    waiting AS (
      SELECT rd.request_id, count(*)::int AS n
      FROM readable rd
      LEFT JOIN last_staff ls ON ls.request_id = rd.request_id
      WHERE rd.author_role IN ('customer', 'provider')
        AND (ls.staff_at IS NULL OR rd.created_at > ls.staff_at)
      GROUP BY rd.request_id
    )`;
}

export type ConversationRow = {
  id: string;
  number: number;
  status: string;
  title: string;
  staffOwnerId: string | null;
  customerName: string;
  providerId: string | null;
  channel: MessageChannelName;
  authorId: string | null;
  authorRole: string;
  text: string;
  lastMessageAt: Date;
  waiting: number;
};

export type ConversationPageInput = ConversationSqlInput & {
  statuses?: readonly string[];
  cursor?: ConversationCursor;
  /** Rows to fetch; the service asks for one more than the page size. */
  take: number;
};

/** One page of conversations, newest last message first, ties by request number. */
export function conversationRowsSql(input: ConversationPageInput): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (input.statuses?.length)
    conditions.push(Prisma.sql`e.status::text = ANY(${[...input.statuses]})`);
  if (input.cursor) {
    // created_at is timestamp(3) in UTC; the cursor carries the same instant.
    const at = Prisma.sql`(${input.cursor.at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    conditions.push(
      Prisma.sql`(lm.created_at < ${at} OR (lm.created_at = ${at} AND e.number < ${input.cursor.number}))`,
    );
  }
  const where = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;
  return Prisma.sql`${conversationCtes(input)}
    SELECT e.id,
           e.number,
           e.status::text AS status,
           e.title,
           e.staff_owner_id AS "staffOwnerId",
           e.customer_name AS "customerName",
           e.current_provider_id AS "providerId",
           lm.channel::text AS channel,
           lm.author_id AS "authorId",
           lm.author_role AS "authorRole",
           lm.text,
           lm.created_at AS "lastMessageAt",
           COALESCE(w.n, 0)::int AS waiting
    FROM last_msg lm
    JOIN eligible e ON e.id = lm.request_id
    LEFT JOIN waiting w ON w.request_id = lm.request_id
    ${where}
    ORDER BY lm.created_at DESC, e.number DESC
    LIMIT ${input.take}`;
}

export type ConversationStatusCountRow = { status: string; count: number };

/** Conversations per request status, with `q` applied and no status filter. */
export function conversationStatusCountsSql(
  input: ConversationSqlInput,
): Prisma.Sql {
  return Prisma.sql`${conversationCtes(input)}
    SELECT e.status::text AS status, count(*)::int AS count
    FROM last_msg lm
    JOIN eligible e ON e.id = lm.request_id
    GROUP BY e.status`;
}
