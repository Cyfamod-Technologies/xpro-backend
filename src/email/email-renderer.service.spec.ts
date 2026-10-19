import { ConfigService } from '@nestjs/config';
import { EmailRendererService } from './email-renderer.service';
import type { EmailTemplateKey, EmailTemplatePayloadMap } from './email.types';

describe('EmailRendererService', () => {
  const renderer = new EmailRendererService(
    new ConfigService({
      APP_NAME: 'Xpro',
      FRONTEND_URL: 'https://app.example.com',
      EMAIL_ASSET_BASE_URL: 'https://app.example.com/email/v1',
      EMAIL_SUPPORT_ADDRESS: 'support@example.com',
    }),
  );

  const fixtures: {
    [K in EmailTemplateKey]: EmailTemplatePayloadMap[K];
  } = {
    welcome: { firstName: 'Ada' },
    email_verification: {
      firstName: 'Ada',
      code: '123456',
    },
    password_reset: {
      firstName: 'Ada',
      resetToken: 'reset/token',
    },
    custom_email: {
      subject: 'A trusted custom notification',
      html: '<p>Trusted content</p>',
      text: 'Trusted content',
    },
    staff_invite: {
      name: 'Alex Example',
      token: 'invite-token',
      expiresAt: '2026-10-22T10:00:00.000Z',
    },
  };

  it.each(Object.keys(fixtures) as EmailTemplateKey[])(
    'renders the %s template with both body formats',
    (templateKey) => {
      const result = renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey,
        payload: fixtures[templateKey],
      });

      expect(result.subject).toBeTruthy();
      expect(result.preheader).toBeTruthy();
      expect(result.html).toContain('<!doctype html>');
      expect(result.html).toContain('Xpro');
      expect(result.text).toBeTruthy();
    },
  );

  it('takes the brand name from APP_NAME and derives a logo monogram', () => {
    const branded = new EmailRendererService(
      new ConfigService({ APP_NAME: 'Northwind Labs' }),
    );
    const result = branded.render({
      recipientEmail: 'ada@example.com',
      templateKey: 'welcome',
      payload: fixtures.welcome,
    });

    expect(result.subject).toContain('Northwind Labs');
    expect(result.html).toContain('NL');
    expect(result.html).not.toContain('Xpro');
  });

  it('escapes untrusted names', () => {
    const result = renderer.render({
      recipientEmail: 'ada@example.com',
      templateKey: 'welcome',
      payload: { firstName: '<script>alert(1)</script>' },
    });

    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<script>alert(1)</script>');
  });

  it('renders email verification as a code without a verification URL', () => {
    const result = renderer.render({
      recipientEmail: 'ada+test@example.com',
      templateKey: 'email_verification',
      payload: {
        firstName: 'Ada',
        code: '123456',
      },
    });

    // Each digit renders in its own cell, so assert on the cells rather than
    // on a contiguous "123456" that never appears in the markup.
    const cellDigits = [
      ...result.html.matchAll(
        /<td class="email-code-cell"[^>]*>([^<]*)<\/td>/g,
      ),
    ].map((match) => match[1].trim());
    expect(cellDigits).toHaveLength(6);
    expect(cellDigits.join('')).toBe('123456');
    expect(result.text).toContain('Verification code: 123456');
    expect(result.html).not.toContain('/verify-email');
    expect(result.text).not.toContain('/verify-email');
    expect(result.html).not.toContain('token=');
  });

  it('rejects a payload with a missing required field', () => {
    expect(() =>
      renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'password_reset',
        payload: { firstName: 'Ada' },
      }),
    ).toThrow('resetToken');
  });

  it('uses the frontend origin when FRONTEND_URL contains an asset path', () => {
    const rendererWithAssetPath = new EmailRendererService(
      new ConfigService({
        FRONTEND_URL: 'https://app.example.com/email/v1/logo.png',
      }),
    );
    const result = rendererWithAssetPath.render({
      recipientEmail: 'ada@example.com',
      templateKey: 'password_reset',
      payload: fixtures.password_reset,
    });

    expect(result.html).toContain(
      'https://app.example.com/reset-password?token=reset%2Ftoken',
    );
    expect(result.html).not.toContain('logo.png/reset-password');
  });

  it('rejects an unsupported template key', () => {
    expect(() =>
      renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'unsupported' as EmailTemplateKey,
        payload: {},
      }),
    ).toThrow('Unsupported email template: unsupported');
  });
});
