import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma, RequestTimer } from '@prisma/client';
import { Job } from 'bullmq';
import { FailedJobsService } from '../../jobs/failed-jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TIMER_BACKOFF_MS,
  TIMER_BATCH_SIZE,
  TIMER_CLAIM_LEASE_MS,
  TIMER_FAILED_JOB_NAME,
  TIMER_MAX_ATTEMPTS,
  TIMER_MAX_BATCHES,
  TIMERS_QUEUE,
} from './timers.constants';
import { TimerRegistry } from './timer-registry';

const UNIQUE_VIOLATION = 'P2002';

@Processor(TIMERS_QUEUE)
export class TimersProcessor extends WorkerHost {
  private readonly logger = new Logger(TimersProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TimerRegistry,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  /** Handles `timers.sweep`, `timers.kick` and a retried FailedJob (`request.timer`). */
  async process(job: Job<{ timerId?: string }>): Promise<void> {
    if (job.name === TIMER_FAILED_JOB_NAME && job.data.timerId)
      await this.revive(job.data.timerId);
    await this.processDue();
    await this.runSweepers();
  }

  /** A failing sweeper is logged and never blocks the others or the next sweep. */
  private async runSweepers(now = new Date()): Promise<void> {
    for (const sweeper of this.registry.sweepHandlers()) {
      try {
        await sweeper(now);
      } catch (error) {
        this.logger.error(`Timers sweeper failed: ${String(error)}`);
      }
    }
  }

  /** Runs every due timer (oldest first, 50 at a time). Returns how many handlers succeeded. */
  async processDue(now = new Date()): Promise<number> {
    await this.failStuck(now);
    let succeeded = 0;
    for (let batch = 0; batch < TIMER_MAX_BATCHES; batch += 1) {
      const rows = await this.claim(now);
      for (const row of rows) if (await this.run(row, now)) succeeded += 1;
      if (rows.length < TIMER_BATCH_SIZE) break;
    }
    return succeeded;
  }

  /**
   * Claims due rows in one statement: `FOR UPDATE SKIP LOCKED` keeps parallel
   * sweeps off each other's rows, and the lease on `next_attempt_at` makes a
   * row whose worker died due again.
   */
  private async claim(now: Date): Promise<RequestTimer[]> {
    const nowSql = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const leaseEnd = new Date(now.getTime() + TIMER_CLAIM_LEASE_MS);
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        UPDATE request_timers
        SET status = 'running',
            attempts = attempts + 1,
            next_attempt_at = (${leaseEnd.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        WHERE id IN (
          SELECT id FROM request_timers
          WHERE (status = 'pending' AND due_at <= ${nowSql}
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowSql}))
             OR (status = 'running' AND next_attempt_at <= ${nowSql}
                 AND attempts < ${TIMER_MAX_ATTEMPTS})
          ORDER BY due_at ASC
          LIMIT ${TIMER_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED)
        RETURNING id`,
    );
    if (claimed.length === 0) return [];
    return this.prisma.requestTimer.findMany({
      where: { id: { in: claimed.map(({ id }) => id) } },
      orderBy: { dueAt: 'asc' },
    });
  }

  private async run(row: RequestTimer, now: Date): Promise<boolean> {
    const handler = this.registry.get(row.kind);
    if (!handler) {
      await this.fail(row, new Error(`Unknown timer kind: ${row.kind}`));
      return false;
    }
    try {
      await handler(row);
      await this.prisma.requestTimer.updateMany({
        where: { id: row.id, status: 'running' },
        data: {
          status: 'done',
          firedAt: now,
          lastError: null,
          nextAttemptAt: null,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Timer ${row.kind} id=${row.id} attempt=${row.attempts}/${TIMER_MAX_ATTEMPTS} failed: ${message}`,
      );
      if (row.attempts >= TIMER_MAX_ATTEMPTS) await this.fail(row, error);
      else await this.retryLater(row, message, now);
      return false;
    }
  }

  private async retryLater(row: RequestTimer, message: string, now: Date) {
    try {
      await this.prisma.requestTimer.updateMany({
        where: { id: row.id, status: 'running' },
        data: {
          status: 'pending',
          lastError: message,
          nextAttemptAt: new Date(
            now.getTime() + TIMER_BACKOFF_MS[row.attempts - 1],
          ),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.prisma.requestTimer.updateMany({
        where: { id: row.id, status: 'running' },
        data: {
          status: 'cancelled',
          lastError: `${message} (superseded by a newer pending timer)`,
          nextAttemptAt: null,
        },
      });
    }
  }

  /** Terminal failure: unknown kind, or the fifth failed attempt. */
  private async fail(row: RequestTimer, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.requestTimer.updateMany({
      where: { id: row.id, status: 'running' },
      data: { status: 'failed', lastError: message, nextAttemptAt: null },
    });
    await this.failedJobs.recordFinal(TIMERS_QUEUE, {
      jobId: row.id,
      jobName: TIMER_FAILED_JOB_NAME,
      payload: {
        timerId: row.id,
        requestId: row.requestId,
        kind: row.kind,
        refId: row.refId,
        payload: row.payload,
      },
      error,
    });
  }

  /** A claimed row on its last attempt whose worker never reported back. */
  private async failStuck(now: Date) {
    const stuck = await this.prisma.requestTimer.findMany({
      where: {
        status: 'running',
        nextAttemptAt: { lte: now },
        attempts: { gte: TIMER_MAX_ATTEMPTS },
      },
    });
    for (const row of stuck)
      await this.fail(row, new Error('Timer handler did not finish.'));
  }

  /** `FailedJobsService.retry` re-queues a failed timer: run it again from attempt 1. */
  private async revive(timerId: string) {
    try {
      await this.prisma.requestTimer.updateMany({
        where: { id: timerId, status: 'failed' },
        data: {
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          dueAt: new Date(),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      this.logger.warn(
        `Timer ${timerId} not revived: a pending timer already exists for it`,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}
