import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from './jobs.service';

@Injectable()
export class FailedJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  async record(queueName: string, job: Job, error: unknown) {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 < attempts) return;

    await this.recordFinal(queueName, {
      jobId: String(job.id),
      jobName: job.name,
      payload: job.data ?? {},
      error,
    });
  }

  /** For work retried outside BullMQ (outbox rows): records the final failure unconditionally. */
  async recordFinal(
    queueName: string,
    failure: {
      jobId: string;
      jobName: string;
      payload: unknown;
      error: unknown;
    },
  ) {
    const payload = failure.payload as Prisma.InputJsonValue;
    await this.prisma.failedJob.upsert({
      where: { queueName_jobId: { queueName, jobId: failure.jobId } },
      create: {
        queueName,
        jobId: failure.jobId,
        jobName: failure.jobName,
        payload,
        errorMessage: this.errorMessage(failure.error),
      },
      update: {
        jobName: failure.jobName,
        payload,
        errorMessage: this.errorMessage(failure.error),
        failedAt: new Date(),
      },
    });
  }

  list(queueName?: string) {
    return this.prisma.failedJob.findMany({
      where: { queueName },
      orderBy: { failedAt: 'desc' },
      take: 200,
    });
  }

  async retry(id: string) {
    const failed = await this.prisma.failedJob.findUnique({ where: { id } });
    if (!failed) throw new NotFoundException('Failed job not found');

    const queue = this.jobs.getQueue(failed.queueName);
    if (!queue) throw new NotFoundException('Queue not registered');

    const job = await queue.add(failed.jobName, failed.payload);
    await this.prisma.failedJob.update({
      where: { id },
      data: { retriedAt: new Date() },
    });

    return { retriedJobId: job.id, queueName: failed.queueName };
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
