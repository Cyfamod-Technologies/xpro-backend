# SMTP

Not wired up — the shipped transport is [ZeptoMail](zeptomail.md). SMTP is the
useful alternative because one implementation covers **Amazon SES, Mailgun,
Postmark, Resend, SendGrid, Brevo and Gmail** — only host, port and credentials
differ.

Only `src/email/email.service.ts` changes. Renderer, templates, queueing and the
`Notification` record are transport-agnostic.

## 1. Install

```bash
npm install nodemailer
npm install -D @types/nodemailer
```

Remove `zeptomail` from `package.json` once the swap is done.

## 2. Replace the transport

`src/email/email.service.ts` — the class keeps its public surface
(`sendQueuedEmail`) and its helpers (`parseEmailFrom`, `maskEmail`); only the
client and the send method change:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailRendererService } from './email-renderer.service';
import type { QueuedEmail, SentEmailResult } from './email.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;
  private readonly from: { address: string; name: string };
  private readonly replyTo?: { address: string; name: string };
  private readonly configured: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly renderer: EmailRendererService,
  ) {
    const host = this.config.get<string>('SMTP_HOST', '');
    const user = this.config.get<string>('SMTP_USER', '');
    const pass = this.config.get<string>('SMTP_PASSWORD', '');
    const port = Number(this.config.get<string>('SMTP_PORT', '587'));

    this.configured = Boolean(host && user && pass);

    this.from = this.parseEmailFrom(
      this.config.get<string>('EMAIL_FROM', 'noreply@example.com'),
      this.config.get<string>('EMAIL_FROM_NAME'),
    );
    const replyTo = this.config.get<string>('EMAIL_REPLY_TO');
    this.replyTo = replyTo ? this.parseEmailFrom(replyTo) : undefined;

    this.transporter = createTransport({
      host,
      port,
      // 465 uses implicit TLS; 587 upgrades via STARTTLS.
      secure: port === 465,
      auth: { user, pass },
      pool: true,
      maxConnections: 5,
    });

    if (!this.configured) {
      this.logger.warn('SMTP is not configured');
    }
  }

  async sendQueuedEmail(input: QueuedEmail): Promise<SentEmailResult> {
    const rendered = this.renderer.render({
      recipientEmail: input.recipientEmail,
      templateKey: input.templateKey,
      payload: input.payload,
    });

    if (!this.configured) {
      throw new Error('SMTP is not configured');
    }

    try {
      const info = await this.transporter.sendMail({
        from: { address: this.from.address, name: this.from.name },
        to: input.recipientEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(this.replyTo && { replyTo: this.replyTo }),
        headers: { 'X-Notification-Id': input.notificationId },
      });

      this.logger.log(
        `SMTP sent to=${this.maskEmail(input.recipientEmail)} messageId=${info.messageId}`,
      );
      return { provider: 'smtp', id: info.messageId, response: info };
    } catch (error) {
      this.logger.error(
        `SMTP failed to=${this.maskEmail(input.recipientEmail)} error=${String(error)}`,
      );
      throw error;
    }
  }
}
```

`SentEmailResult.provider` is typed `string`, so returning `'smtp'` needs no type
change.

## 3. Update env validation

`src/config/env.validation.ts`:

```diff
   if (config['NODE_ENV'] === 'production') {
-    if (!config['ZEPTOMAIL_TOKEN']) {
+    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
+      if (!config[key]) {
         throw new Error(
-          'ZEPTOMAIL_TOKEN is required in production — see docs/email/README.md',
+          `${key} is required in production — see docs/email/smtp.md`,
         );
+      }
     }
```

## 4. Configure

```bash
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<smtp-username>
SMTP_PASSWORD=<smtp-password>
EMAIL_FROM=noreply@example.com
EMAIL_FROM_NAME=Acme
EMAIL_REPLY_TO=support@example.com
```

Replace `ZEPTOMAIL_URL` / `ZEPTOMAIL_TOKEN` in `.env.example` with these.

## Provider settings

| Provider | Host | Port | Username |
| --- | --- | --- | --- |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SES SMTP credentials — **not** your AWS access key |
| Mailgun | `smtp.mailgun.org` | 587 | `postmaster@<domain>` |
| Postmark | `smtp.postmarkapp.com` | 587 | Server API token (as both user and pass) |
| Resend | `smtp.resend.com` | 587 | `resend` |
| SendGrid | `smtp.sendgrid.net` | 587 | `apikey` (literal) |
| Brevo | `smtp-relay.brevo.com` | 587 | Account email |
| Gmail | `smtp.gmail.com` | 587 | Your address + an **App Password** |

Prefer 587 with STARTTLS. Use 465 only if 587 is blocked, and set `secure: true` —
the `port === 465` check above handles it.

SES starts in **sandbox mode**: you can only send to verified addresses until you
request production access. This is the single most common "SES doesn't work"
cause.

Gmail is fine for development but has a ~500/day cap and is not for production.

## 5. Verify

```bash
curl -X POST http://localhost:4000/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

The `notifications` row should reach `status = 'sent'`.

For local development without a real provider, [Mailpit](https://mailpit.axllent.org/)
gives you an SMTP sink and a web UI. Add to `docker-compose.yml`:

```yaml
  mailpit:
    image: axllent/mailpit
    container_name: app-mailpit
    ports:
      - '1025:1025'   # SMTP
      - '8025:8025'   # Web UI
```

Then `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, and any values for user/password
(the `configured` check only tests for non-empty strings).

## Deliverability

The same DNS work applies regardless of transport: SPF, DKIM and DMARC on the
sending domain. See [zeptomail.md](zeptomail.md#1-add-and-verify-a-domain) — the
record types are identical, only the values come from your provider.
