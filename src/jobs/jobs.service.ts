import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { EmailJobData } from '../email/email.types';
import { QUEUE_NAMES } from './jobs.constants';

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
  ) {}

  async onModuleInit() {
    await this.platformQueue.upsertJobScheduler(
      'idempotency-cleanup',
      { every: 60 * 60 * 1000 },
      { name: 'idempotency.cleanup' },
    );
  }

  addEmailJob(name: string, data: EmailJobData) {
    return this.emailQueue.add(name, data);
  }

  addAuditLogJob(data: Record<string, unknown>) {
    return this.auditLogsQueue.add('write', data, { attempts: 5 });
  }

  getQueue(name: string): Queue | null {
    const queues: Record<string, Queue> = {
      email: this.emailQueue,
      'audit-logs': this.auditLogsQueue,
      platform: this.platformQueue,
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
