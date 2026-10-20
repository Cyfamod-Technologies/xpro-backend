import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailRendererService } from './email-renderer.service';
import type { QueuedEmail, SentEmailResult } from './email.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter?: Transporter;
  private readonly from: { address: string; name: string };
  private readonly replyTo?: { address: string; name: string };

  constructor(
    private readonly config: ConfigService,
    private readonly renderer: EmailRendererService,
  ) {
    const host = this.config.get<string>('SMTP_HOST', '');
    const user = this.config.get<string>('SMTP_USER', '');
    const password = this.config.get<string>('SMTP_PASSWORD', '');
    const port = Number(this.config.get<string>('SMTP_PORT', '465'));
    this.from = this.parseEmailFrom(
      this.config.get<string>('EMAIL_FROM', 'noreply@example.com'),
      this.config.get<string>('EMAIL_FROM_NAME'),
    );
    const replyTo = this.config.get<string>('EMAIL_REPLY_TO');
    this.replyTo = replyTo ? this.parseEmailFrom(replyTo) : undefined;
    if (host && user && password && (port === 465 || port === 587)) {
      this.transporter = createTransport({
        host,
        port,
        secure: port === 465,
        requireTLS: port === 587,
        auth: { user, pass: password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    } else {
      this.logger.warn('SMTP is not configured');
    }
  }

  async sendQueuedEmail(input: QueuedEmail): Promise<SentEmailResult> {
    const rendered = this.renderer.render({
      recipientEmail: input.recipientEmail,
      templateKey: input.templateKey,
      payload: input.payload,
    });
    if (!this.transporter) {
      throw new Error('SMTP is not configured');
    }

    try {
      const response = await this.transporter.sendMail({
        from: this.from,
        to: input.recipientEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(this.replyTo && { replyTo: this.replyTo }),
        headers: { 'X-Notification-Id': input.notificationId },
      });
      this.logger.log(
        `SMTP sent to=${this.maskEmail(input.recipientEmail)} messageId=${response.messageId}`,
      );
      return { provider: 'smtp', id: response.messageId, response };
    } catch (error) {
      this.logger.error(
        `SMTP failed to=${this.maskEmail(input.recipientEmail)} error=${String(error)}`,
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
}
