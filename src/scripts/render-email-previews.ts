import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { EmailRendererService } from '../email/email-renderer.service';
import type {
  EmailTemplateKey,
  EmailTemplatePayloadMap,
} from '../email/email.types';

const fixtures: {
  [K in Exclude<EmailTemplateKey, 'custom_email'>]: EmailTemplatePayloadMap[K];
} = {
  welcome: { firstName: 'Ada' },
  email_verification: {
    firstName: 'Ada',
    token: 'preview-verification-token',
  },
  password_reset: {
    firstName: 'Ada',
    resetToken: 'preview-reset-token',
  },
  staff_invite: {
    name: 'Alex Example',
    token: 'preview-invite-token',
    expiresAt: '2026-10-22T10:00:00.000Z',
  },
  request_update: {
    title: 'Request received',
    message: 'We have received your request and will review it shortly.',
    link: '/requests',
  },
};

async function main() {
  const outputDirectory = resolve(process.cwd(), '.email-previews');
  const renderer = new EmailRendererService(
    new ConfigService({
      FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:3000',
      EMAIL_ASSET_BASE_URL:
        process.env.EMAIL_ASSET_BASE_URL ?? 'http://localhost:3000/email/v1',
      APP_NAME: process.env.APP_NAME ?? 'Xpro',
      EMAIL_SUPPORT_ADDRESS:
        process.env.EMAIL_SUPPORT_ADDRESS ?? 'support@example.com',
      EMAIL_PRIVACY_URL: process.env.EMAIL_PRIVACY_URL,
      EMAIL_TERMS_URL: process.env.EMAIL_TERMS_URL,
    }),
  );

  await mkdir(outputDirectory, { recursive: true });

  const templateKeys = Object.keys(fixtures) as (keyof typeof fixtures)[];
  const requestedTemplate = process.argv[2] as
    keyof typeof fixtures | undefined;
  if (requestedTemplate && !templateKeys.includes(requestedTemplate)) {
    throw new Error(`Unknown email template: ${requestedTemplate}`);
  }
  const selectedTemplates = requestedTemplate
    ? [requestedTemplate]
    : templateKeys;

  for (const templateKey of selectedTemplates) {
    const rendered = renderer.render({
      recipientEmail: 'ada@example.com',
      templateKey,
      payload: fixtures[templateKey],
    });

    const htmlPath = resolve(outputDirectory, `${templateKey}.html`);
    const textPath = resolve(outputDirectory, `${templateKey}.txt`);
    await Promise.all([
      writeFile(htmlPath, rendered.html),
      writeFile(textPath, rendered.text),
    ]);
    console.log(htmlPath);
    console.log(textPath);
  }
}

void main();
