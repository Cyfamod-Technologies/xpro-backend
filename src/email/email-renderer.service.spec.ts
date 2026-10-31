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
      token: 'verification-token',
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
    request_update: {
      title: 'Request received',
      message: 'We have received your request.',
      link: '/requests',
    },
    account_exists: { firstName: 'Ada' },
    staff_account_exists: { firstName: 'Ada' },
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

  it('uses the Xpro logo asset and takes the brand name from APP_NAME', () => {
    const branded = new EmailRendererService(
      new ConfigService({
        APP_NAME: 'Northwind Labs',
        FRONTEND_URL: 'https://app.example.com',
      }),
    );
    const result = branded.render({
      recipientEmail: 'ada@example.com',
      templateKey: 'welcome',
      payload: fixtures.welcome,
    });

    expect(result.subject).toContain('Northwind Labs');
    expect(result.html).toContain(
      'https://app.example.com/images/xpro-logo-transparent.png',
    );
    expect(result.html).toContain('alt="Northwind Labs"');
    expect(result.html).not.toContain('Xpro');
  });

  it('uses the dashboard primary color in branded buttons', () => {
    const result = renderer.render({
      recipientEmail: 'ada@example.com',
      templateKey: 'welcome',
      payload: fixtures.welcome,
    });

    expect(result.html).toContain('#4AA7DF');
    expect(result.html).toContain('#102A3A');
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

  it('renders email verification as a link', () => {
    const result = renderer.render({
      recipientEmail: 'ada+test@example.com',
      templateKey: 'email_verification',
      payload: {
        firstName: 'Ada',
        token: 'verification-token',
      },
    });

    expect(result.html).toContain(
      'https://app.example.com/auth/verify-email?token=verification-token',
    );
    expect(result.text).toContain(
      'Verification link: https://app.example.com/auth/verify-email?token=verification-token',
    );
    expect(result.html).not.toContain('Verification code');
    expect(result.text).not.toContain('Verification code');
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

  describe('account_exists', () => {
    const recipientEmail = 'ada+secret@example.com';

    it('links to sign in and password reset without the recipient email', () => {
      const result = renderer.render({
        recipientEmail,
        templateKey: 'account_exists',
        payload: { firstName: 'Ada' },
      });

      expect(result.subject).toBe('You already have an Xpro account');
      expect(result.html).toContain('https://app.example.com/login"');
      expect(result.html).toContain(
        'https://app.example.com/auth/forgot-password"',
      );
      expect(result.text).toContain('https://app.example.com/login');
      expect(result.text).toContain(
        'https://app.example.com/auth/forgot-password',
      );
      expect(result.html).not.toContain('scheduled for deletion');
      expect(result.html).not.toContain('ada+secret');
      expect(result.html).not.toContain('ada%2Bsecret');
      expect(result.text).not.toContain('ada+secret');
    });

    it('shows the deletion notice only when a deletion date is given', () => {
      const result = renderer.render({
        recipientEmail,
        templateKey: 'account_exists',
        payload: { deletionScheduledFor: '2026-11-20T10:00:00.000Z' },
      });

      expect(result.html).toContain('Your account is scheduled for deletion');
      expect(result.html).toContain(
        'Sign in before 20 November 2026 to cancel your account deletion.',
      );
      expect(result.text).toContain(
        'Sign in before 20 November 2026 to cancel your account deletion.',
      );
    });
  });

  describe('staff_account_exists', () => {
    it('explains that no account was created and links nowhere in the app', () => {
      const result = renderer.render({
        recipientEmail: 'alex+secret@example.com',
        templateKey: 'staff_account_exists',
        payload: {},
      });

      expect(result.subject).toBe(
        'This email is used by an Xpro staff account',
      );
      expect(result.html).toContain('This email belongs to a staff account');
      expect(result.html).not.toContain('href="https://app.example.com');
      expect(result.html).not.toContain('alex+secret');
      expect(result.text).not.toContain('alex+secret');
    });
  });

  describe('request_update', () => {
    it('renders the title, message and a link button on the frontend origin', () => {
      const result = renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'request_update',
        payload: {
          title: 'Quote ready',
          message: 'Your quote is ready to review.',
          link: '/requests/abc?tab=quote',
        },
      });

      expect(result.subject).toBe('Quote ready');
      expect(result.html).toContain('Your quote is ready to review.');
      expect(result.html).toContain(
        'https://app.example.com/requests/abc?tab=quote',
      );
      expect(result.text).toContain(
        'https://app.example.com/requests/abc?tab=quote',
      );
    });

    it('omits the button when there is no link and ignores non-path links', () => {
      const withoutLink = renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'request_update',
        payload: { title: 'Update', message: 'Something changed.' },
      });
      expect(withoutLink.html).not.toContain('View details');

      const external = renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'request_update',
        payload: {
          title: 'Update',
          message: 'Something changed.',
          link: 'https://evil.example.net/x',
        },
      });
      expect(external.html).not.toContain('evil.example.net');
    });

    it('escapes the title and message', () => {
      const result = renderer.render({
        recipientEmail: 'ada@example.com',
        templateKey: 'request_update',
        payload: { title: '<b>x</b>', message: '<script>1</script>' },
      });
      expect(result.html).not.toContain('<script>1</script>');
      expect(result.html).toContain('&lt;script&gt;1&lt;/script&gt;');
    });

    it('rejects a payload without a message', () => {
      expect(() =>
        renderer.render({
          recipientEmail: 'ada@example.com',
          templateKey: 'request_update',
          payload: { title: 'Update' },
        }),
      ).toThrow('missing message');
    });
  });
});
