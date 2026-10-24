import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { FailedJobsService } from '../failed-jobs.service';
import { UploadsService } from '../../uploads/uploads.service';

@Processor('platform')
export class PlatformProcessor extends WorkerHost {
  private readonly logger = new Logger(PlatformProcessor.name);

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly failedJobs: FailedJobsService,
    private readonly uploads: UploadsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    try {
      if (job.name === 'idempotency.cleanup') {
        const count = await this.idempotency.deleteExpired();
        this.logger.log(`idempotency.cleanup deleted=${count}`);
        return;
      }
      if (job.name === 'uploads.cleanup') {
        const count = await this.uploads.cleanupUnattachedOlderThan24Hours();
        this.logger.log(`uploads.cleanup deleted=${count}`);
        return;
      }
      this.logger.warn(`Unknown platform job ${job.name}`);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.failedJobs.record('platform', job, error);
      }
      throw error;
    }
  }
}
