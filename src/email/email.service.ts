import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMailClient, type Sendmail } from 'zeptomail';
import { EmailRendererService } from './email-renderer.service';
import type { QueuedEmail, SentEmailResult } from './email.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: SendMailClient;
  private readonly from: { address: string; name: string };
  private readonly replyTo?: { address: string; name: string };
  private readonly zeptoToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly renderer: EmailRendererService,
  ) {
    const zeptoUrl = this.config.get<string>(
      'ZEPTOMAIL_URL',
      'https://api.zeptomail.com/v1.1/email',
    );
    this.zeptoToken = this.config.get<string>('ZEPTOMAIL_TOKEN', '');
    this.from = this.parseEmailFrom(
      this.config.get<string>('EMAIL_FROM', 'noreply@example.com'),
      this.config.get<string>('EMAIL_FROM_NAME'),
    );
    const replyTo = this.config.get<string>('EMAIL_REPLY_TO');
    this.replyTo = replyTo ? this.parseEmailFrom(replyTo) : undefined;
    this.client = new SendMailClient({
      url: zeptoUrl,
      token: this.zeptoToken,
    });

    if (!this.zeptoToken) {
      this.logger.warn('ZEPTOMAIL_TOKEN is not configured');
    }
  }

  async sendQueuedEmail(input: QueuedEmail): Promise<SentEmailResult> {
    const rendered = this.renderer.render({
      recipientEmail: input.recipientEmail,
      templateKey: input.templateKey,
      payload: input.payload,
    });
    return this.sendWithZeptoMail({
      notificationId: input.notificationId,
      to: input.recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  private async sendWithZeptoMail(options: {
    notificationId: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<SentEmailResult> {
    if (!this.zeptoToken) {
      throw new Error('ZEPTOMAIL_TOKEN is not configured');
    }

    const email: Sendmail = {
      from: this.from,
      to: [
        {
          email_address: {
            address: options.to,
            name: this.nameFromEmail(options.to),
          },
        },
      ],
      subject: options.subject,
      htmlbody: options.html,
      textbody: options.text,
      client_reference: options.notificationId,
      track_clicks: false,
      track_opens: false,
      ...(this.replyTo && { reply_to: [this.replyTo] }),
    };

    try {
      const response = await this.client.sendMail(email);
      const id = this.extractProviderId(response);
      this.logger.log(
        `ZeptoMail sent to=${this.maskEmail(options.to)} providerId=${id ?? 'none'}`,
      );
      return { provider: 'zeptomail', id, response };
    } catch (error) {
      this.logger.error(
        `ZeptoMail failed to=${this.maskEmail(options.to)} error=${String(error)}`,
      );
      throw error;
    }
  }

  private parseEmailFrom(value: string, configuredName?: string) {
    const match = value.match(/^(.*?)\s*<([^>]+)>$/);
    const address = (match?.[2] ?? value).trim();
    const name = (configuredName ?? match?.[1] ?? this.nameFromEmail(address))
      .trim()
      .replace(/^"|"$/g, '');

    return { address, name: name || this.nameFromEmail(address) };
  }

  private nameFromEmail(email: string) {
    return email.split('@')[0] || 'noreply';
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local?.charAt(0) || '*'}***@${domain}`;
  }

  private extractProviderId(response: unknown): string | undefined {
    const seen = new Set<unknown>();
    const pending: unknown[] = [response];
    const keys = ['message_id', 'messageId', 'id', 'request_id', 'requestId'];

    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || typeof current !== 'object' || seen.has(current)) {
        continue;
      }
      seen.add(current);

      const record = current as Record<string, unknown>;
      for (const key of keys) {
        if (typeof record[key] === 'string') {
          return record[key];
        }
      }

      pending.push(...Object.values(record));
    }

    return undefined;
  }
}
