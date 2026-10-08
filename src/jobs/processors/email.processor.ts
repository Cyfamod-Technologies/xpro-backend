import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from '../../email/email.service';
import type { EmailJobData, SentEmailResult } from '../../email/email.types';
import { PrismaService } from '../../prisma/prisma.service';
import { FailedJobsService } from '../failed-jobs.service';

@Processor('email')
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    const { notificationId, recipientEmail, templateKey, payload } = job.data;
    this.logger.log(
      `Sending email notificationId=${notificationId} to=${this.maskEmail(recipientEmail)} template=${templateKey}`,
    );

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'processing' },
    });

    let result: SentEmailResult;
    try {
      result = await this.email.sendQueuedEmail({
        notificationId,
        recipientEmail,
        templateKey,
        payload,
      });
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const finalAttempt = job.attemptsMade + 1 >= attempts;
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: finalAttempt ? 'failed' : 'retrying' },
      });
      if (finalAttempt) {
        await this.failedJobs.record('email', job, error);
      }
      this.logger.error(
        `Email ${finalAttempt ? 'failed' : 'retrying'} notificationId=${notificationId} to=${this.maskEmail(recipientEmail)} error=${String(error)}`,
      );
      throw error;
    }

    try {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'sent', sentAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `Email delivered but status persistence failed notificationId=${notificationId} error=${String(error)}`,
      );
    }

    this.logger.log(
      `Email sent notificationId=${notificationId} to=${this.maskEmail(recipientEmail)} provider=${result.provider} providerId=${result.id ?? 'none'}`,
    );
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local?.charAt(0) || '*'}***@${domain}`;
  }
}
