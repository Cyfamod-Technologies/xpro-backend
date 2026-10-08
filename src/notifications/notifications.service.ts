import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import type {
  EmailTemplateKey,
  EmailTemplatePayloadMap,
} from '../email/email.types';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';

interface QueueEmailInput<K extends EmailTemplateKey> {
  recipientEmail: string;
  recipientUserId?: string;
  channel?: string;
  templateKey: K;
  type: string;
  payload: EmailTemplatePayloadMap[K];
  cooldown?: {
    key: string;
    seconds: number;
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async queueEmail<K extends EmailTemplateKey>(input: QueueEmailInput<K>) {
    if (input.cooldown) {
      const acquired = await this.redis.set(
        `email_cooldown:${input.cooldown.key}`,
        '1',
        'EX',
        input.cooldown.seconds,
        'NX',
      );
      if (acquired !== 'OK') {
        this.logger.log(
          `Email suppressed cooldown=${input.cooldown.key} template=${input.templateKey}`,
        );
        return null;
      }
    }

    const payload = this.cleanPayload(input.payload);
    const notification = await this.prisma.notification.create({
      data: {
        recipientEmail: input.recipientEmail,
        recipientUserId: input.recipientUserId,
        channel: input.channel ?? 'email',
        templateKey: input.templateKey,
        type: input.type,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    const job = await this.jobs.addEmailJob(input.type, {
      notificationId: notification.id,
      recipientEmail: input.recipientEmail,
      recipientUserId: input.recipientUserId,
      type: input.type,
      templateKey: input.templateKey,
      payload,
    });

    this.logger.log(
      `Email enqueued notificationId=${notification.id} jobId=${job.id} to=${this.maskEmail(input.recipientEmail)} template=${input.templateKey}`,
    );

    return notification;
  }

  private cleanPayload<K extends EmailTemplateKey>(
    payload: EmailTemplatePayloadMap[K],
  ): Record<string, unknown> {
    return this.removeUndefined(payload) as Record<string, unknown>;
  }

  private removeUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) =>
        item === undefined ? null : this.removeUndefined(item),
      );
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, this.removeUndefined(item)]),
      );
    }

    return value;
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local?.charAt(0) || '*'}***@${domain}`;
  }
}
