import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { FailedJobsService } from '../../jobs/failed-jobs.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EmailNotifyPayload,
  OUTBOX_BACKOFF_MS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_EMAIL_NOTIFY,
  OUTBOX_MAX_ATTEMPTS,
} from './outbox.constants';

type OutboxRow = Prisma.OutboxEventGetPayload<object>;

@Processor('outbox')
export class OutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  async process(job: Job<{ outboxEventId?: string }>): Promise<void> {
    if (job.name === 'outbox.event' && job.data.outboxEventId) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: job.data.outboxEventId, processedAt: null },
        data: { attempts: 0, nextAttemptAt: null },
      });
    }
    await this.processPending();
  }

  /** Oldest first. Returns how many rows were delivered. */
  async processPending(now = new Date()): Promise<number> {
    const due = await this.prisma.outboxEvent.findMany({
      where: {
        processedAt: null,
        attempts: { lt: OUTBOX_MAX_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: OUTBOX_BATCH_SIZE,
    });

    let delivered = 0;
    for (const row of due) {
      if (await this.handle(row, now)) delivered += 1;
    }
    return delivered;
  }

  private async handle(row: OutboxRow, now: Date): Promise<boolean> {
    const attempt = row.attempts + 1;
    const claimed = await this.prisma.outboxEvent.updateMany({
      where: {
        id: row.id,
        processedAt: null,
        attempts: row.attempts,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        attempts: attempt,
        nextAttemptAt: new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS),
      },
    });
    if (claimed.count === 0) return false;

    try {
      await this.dispatch(row);
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date(), nextAttemptAt: null, lastError: null },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const final = attempt >= OUTBOX_MAX_ATTEMPTS;
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          lastError: message,
          nextAttemptAt: final
            ? null
            : new Date(now.getTime() + OUTBOX_BACKOFF_MS[attempt - 1]),
        },
      });
      this.logger.error(
        `Outbox ${row.type} id=${row.id} attempt=${attempt}/${OUTBOX_MAX_ATTEMPTS} failed: ${message}`,
      );
      if (final) {
        await this.failedJobs.recordFinal('outbox', {
          jobId: row.id,
          jobName: 'outbox.event',
          payload: {
            outboxEventId: row.id,
            type: row.type,
            payload: row.payload,
          },
          error,
        });
      }
      return false;
    }
  }

  private async dispatch(row: OutboxRow): Promise<void> {
    if (row.type === OUTBOX_EMAIL_NOTIFY) {
      await this.sendEmailNotify(row.payload as unknown as EmailNotifyPayload);
      return;
    }
    throw new Error(`Unknown outbox event type: ${row.type}`);
  }

  private async sendEmailNotify(payload: EmailNotifyPayload): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.recipientId },
      select: { id: true, email: true, status: true },
    });
    if (!user || user.status !== 'active') {
      this.logger.warn(
        `Skipping email.notify for unavailable recipient=${payload.recipientId}`,
      );
      return;
    }
    await this.notifications.queueEmail({
      recipientEmail: user.email,
      recipientUserId: user.id,
      templateKey: 'request_update',
      type: payload.event,
      payload: {
        title: payload.title,
        message: payload.message,
        link: payload.link ?? undefined,
      },
    });
  }
}
