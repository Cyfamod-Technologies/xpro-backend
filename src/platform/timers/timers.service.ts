import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';

type TimersDb = Pick<Prisma.TransactionClient, 'requestTimer' | '$queryRaw'>;

export type StartTimerInput = {
  requestId: string;
  kind: string;
  dueAt: Date;
  /** Assignment, quote or schedule id; omit for the empty reference. */
  refId?: string;
  payload?: Prisma.InputJsonValue;
};

export type StopTimersInput = {
  requestId: string;
  /** Exact kinds, or every kind starting with `prefix` (for example `T6.`). */
  kinds: readonly string[] | { prefix: string };
  /** Limit to one reference; omit to stop the kinds for every reference. */
  refId?: string;
};

@Injectable()
export class TimersService {
  private readonly logger = new Logger(TimersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Starts a timer inside the caller's transaction. Idempotent: if a pending
   * timer already exists for the same (requestId, kind, refId), that row is
   * rescheduled instead of an error being thrown. Its dueAt and payload are
   * replaced (an omitted payload clears it) and its retry state is reset. Call
   * `kick()` after the transaction commits when the timer may already be due.
   */
  async start(
    tx: TimersDb,
    input: StartTimerInput,
  ): Promise<{ id: string; created: boolean }> {
    const payload =
      input.payload === undefined ? null : JSON.stringify(input.payload);
    const rows = await tx.$queryRaw<Array<{ id: string; inserted: boolean }>>(
      Prisma.sql`
        INSERT INTO request_timers (id, request_id, kind, ref_id, due_at, payload, status)
        VALUES (${randomUUID()}, ${input.requestId}, ${input.kind}, ${input.refId ?? ''},
                ${utc(input.dueAt)}, ${payload}::jsonb, 'pending')
        ON CONFLICT (request_id, kind, ref_id) WHERE status = 'pending'
        DO UPDATE SET due_at = EXCLUDED.due_at,
                      payload = EXCLUDED.payload,
                      attempts = 0,
                      last_error = NULL,
                      next_attempt_at = NULL
        RETURNING id, (xmax = 0) AS inserted`,
    );
    return { id: rows[0].id, created: rows[0].inserted };
  }

  /** Cancels matching `pending` timers (a `running` one finishes and finds nothing to do). Returns how many. */
  async stop(tx: TimersDb, input: StopTimersInput): Promise<number> {
    const kind: Prisma.StringFilter<'RequestTimer'> =
      'prefix' in input.kinds
        ? { startsWith: input.kinds.prefix }
        : { in: [...input.kinds] };
    const result = await tx.requestTimer.updateMany({
      where: {
        requestId: input.requestId,
        status: 'pending',
        kind,
        ...(input.refId === undefined ? {} : { refId: input.refId }),
      },
      data: { status: 'cancelled', nextAttemptAt: null },
    });
    return result.count;
  }

  /** Makes matching pending timers due now (dev tool). Does not kick. */
  async makeDue(
    requestId: string,
    kind: string,
    now = new Date(),
  ): Promise<number> {
    const result = await this.prisma.requestTimer.updateMany({
      where: { requestId, kind, status: 'pending' },
      data: { dueAt: now, nextAttemptAt: null },
    });
    return result.count;
  }

  /** Best effort: the 60 s sweep picks up anything a failed kick misses. */
  async kick(): Promise<void> {
    try {
      await this.jobs.addTimersKickJob();
    } catch (error) {
      this.logger.warn(
        `Timers kick failed, sweep will catch up: ${String(error)}`,
      );
    }
  }
}

/** `Date` as a UTC `timestamp` regardless of the session time zone. */
const utc = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
