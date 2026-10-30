import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { PhoneSmsJob } from './processors/sms.processor';
import type { EmailJobData } from '../email/email.types';
import {
  OUTBOX_SWEEP_INTERVAL_MS,
  QUEUE_NAMES,
  TIMERS_SWEEP_INTERVAL_MS,
  UPLOAD_CLEANUP_INTERVAL_MS,
} from './jobs.constants';

/**
 * Single entry point for enqueuing background work. Controllers and services
 * call these methods rather than injecting queues directly, so every producer
 * shares one place to set retry and retention policy.
 *
 * To add a queue: add its name to QUEUE_NAMES, inject it here with a matching
 * `add*Job` method, and register a processor under `processors/`.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  constructor(
    @InjectQueue('email') private readonly emailQueue: Queue,
    @InjectQueue('audit-logs') private readonly auditLogsQueue: Queue,
    @InjectQueue('platform') private readonly platformQueue: Queue,
    @InjectQueue('outbox') private readonly outboxQueue: Queue,
    @InjectQueue('timers') private readonly timersQueue: Queue,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async onModuleInit() {
    await this.platformQueue.upsertJobScheduler(
      'idempotency-cleanup',
      { every: 60 * 60 * 1000 },
      { name: 'idempotency.cleanup' },
    );
    await this.outboxQueue.upsertJobScheduler(
      'outbox-sweep',
      { every: OUTBOX_SWEEP_INTERVAL_MS },
      { name: 'outbox.sweep', opts: { attempts: 1 } },
    );
    await this.timersQueue.upsertJobScheduler(
      'timers-sweep',
      { every: TIMERS_SWEEP_INTERVAL_MS },
      { name: 'timers.sweep', opts: { attempts: 1 } },
    );
    await this.platformQueue.upsertJobScheduler(
      'uploads-cleanup',
      { every: UPLOAD_CLEANUP_INTERVAL_MS },
      { name: 'uploads.cleanup' },
    );
  }

  addEmailJob(name: string, data: EmailJobData) {
    return this.emailQueue.add(name, data);
  }

  addSmsJob(data: PhoneSmsJob) {
    return this.smsQueue.add('phone.verify', data, {
      jobId: data.verificationId,
      attempts: 3,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  addAuditLogJob(data: Record<string, unknown>) {
    return this.auditLogsQueue.add('write', data, { attempts: 5 });
  }

  /** Row-level retries live on `outbox_events`, so the job itself runs once. */
  addOutboxKickJob() {
    return this.outboxQueue.add('outbox.kick', {}, { attempts: 1 });
  }

  /** Row-level retries live on `request_timers`, so the job itself runs once. */
  addTimersKickJob() {
    return this.timersQueue.add('timers.kick', {}, { attempts: 1 });
  }

  getQueue(name: string): Queue | null {
    const queues: Record<string, Queue> = {
      email: this.emailQueue,
      'audit-logs': this.auditLogsQueue,
      platform: this.platformQueue,
      outbox: this.outboxQueue,
      timers: this.timersQueue,
      sms: this.smsQueue,
    };
    return queues[name] ?? null;
  }

  /** Live job counts per queue, for health checks and operations views. */
  async getQueueStats(): Promise<
    Array<{
      name: string;
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>
  > {
    return Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const queue = this.getQueue(name);
        if (!queue) {
          return { name, waiting: 0, active: 0, completed: 0, failed: 0 };
        }
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
        );
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }
}
