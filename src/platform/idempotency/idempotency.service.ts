import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AppError } from '../errors/app-error';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_REUSED_MESSAGE =
  'This Idempotency-Key was already used for a different request.';

type IdempotencyDb = Pick<Prisma.TransactionClient, 'idempotencyKey'>;

export type StoredResponse = { status: number; body: unknown };

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 of method + path + body, with object keys sorted so key order does not matter. */
export function hashRequest(method: string, path: string, body: unknown) {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  hashRequest = hashRequest;

  /**
   * Returns the stored response for `(actorId, key)` when the hash matches,
   * null when there is none (or it has expired), and throws 422
   * IDEMPOTENCY_KEY_REUSED when the key was used with a different hash.
   * Pass `tx` to read inside a transaction.
   */
  async lookup(
    actorId: string,
    key: string,
    hash: string,
    tx?: IdempotencyDb,
  ): Promise<StoredResponse | null> {
    const db = tx ?? this.prisma;
    const row = await db.idempotencyKey.findUnique({
      where: { actorId_key: { actorId, key } },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    if (row.requestHash !== hash) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        IDEMPOTENCY_REUSED_MESSAGE,
      );
    }
    return { status: row.status, body: row.response };
  }

  /**
   * Stores a successful (2xx) response for 24 hours. Non-2xx statuses are
   * ignored: a retry with the same key is evaluated afresh. An existing live
   * row is left untouched, so a concurrent duplicate cannot overwrite it.
   * Pass `tx` to store atomically with the command.
   */
  async store(
    actorId: string,
    key: string,
    hash: string,
    status: number,
    body: unknown,
    tx?: IdempotencyDb,
  ): Promise<void> {
    if (status < 200 || status > 299) return;
    const db = tx ?? this.prisma;
    const now = new Date();
    await db.idempotencyKey.deleteMany({
      where: { actorId, key, expiresAt: { lte: now } },
    });
    await db.idempotencyKey.createMany({
      data: [
        {
          actorId,
          key,
          requestHash: hash,
          status,
          response: (body ?? null) as Prisma.InputJsonValue,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
      ],
      skipDuplicates: true,
    });
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  }
}
