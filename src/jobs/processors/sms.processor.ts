import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { decryptSecret } from '../../common/utils/crypto.util';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from '../../sms/sms.service';
import { FailedJobsService } from '../failed-jobs.service';

export interface PhoneSmsJob {
  verificationId: string;
  encryptedCode: string;
}

@Processor('sms')
export class SmsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  async process(job: Job<PhoneSmsJob>) {
    const verification = await this.prisma.phoneVerification.findUnique({
      where: { id: job.data.verificationId },
    });
    if (
      !verification ||
      verification.consumedAt ||
      verification.expiresAt <= new Date()
    )
      return;
    try {
      await this.sms.sendCode(
        verification.phoneE164,
        decryptSecret(job.data.encryptedCode),
      );
    } catch {
      const error = new Error('Verification SMS delivery failed.');
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.prisma.phoneVerification.updateMany({
          where: { id: verification.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        await this.failedJobs.recordFinal('sms', {
          jobId: String(job.id),
          jobName: job.name,
          payload: { verificationId: verification.id },
          error,
        });
      }
      throw error;
    }
  }
}
