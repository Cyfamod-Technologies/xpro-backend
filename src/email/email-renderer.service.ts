import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EmailRenderContext,
  EmailTemplateKey,
  EmailVerificationPayload,
  PasswordResetPayload,
  RenderedEmail,
  TrustedCustomEmailPayload,
  WelcomeEmailPayload,
} from './email.types';
import {
  asPayloadRecord,
  normalizeFrontendUrl,
  optionalString,
  requiredString,
} from './email-template.utils';
import { renderTrustedCustomEmail } from './templates/custom-email.template';
import { renderEmailVerification } from './templates/email-verification.template';
import { renderPasswordReset } from './templates/password-reset.template';
import { renderWelcomeEmail } from './templates/welcome.template';

/** Derives a short monogram from the app name, e.g. "Xpro Labs" -> "XL". */
function monogram(appName: string): string {
  const initials = appName
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return initials.slice(0, 3) || 'A';
}

/**
 * Maps a template key plus an untyped payload onto a rendered subject/html/text
 * triple. Payloads arrive from the queue as plain JSON, so every field is
 * re-validated here rather than trusted.
 *
 * To add a template: add its key to EMAIL_TEMPLATE_KEYS, add a payload type and
 * a map entry in email.types.ts, add a `templates/<name>.template.ts` renderer,
 * then add a case plus a payload mapper below.
 */
@Injectable()
export class EmailRendererService {
  constructor(private readonly config: ConfigService) {}

  render(input: {
    recipientEmail: string;
    templateKey: EmailTemplateKey;
    payload: unknown;
  }): RenderedEmail {
    const payload = asPayloadRecord(input.payload);
    const context = this.context(input.recipientEmail);

    switch (input.templateKey) {
      case 'welcome':
        return renderWelcomeEmail(this.welcomePayload(payload), context);
      case 'email_verification':
        return renderEmailVerification(
          this.verificationPayload(payload),
          context,
        );
      case 'password_reset':
        return renderPasswordReset(this.passwordResetPayload(payload), context);
      case 'custom_email':
        return renderTrustedCustomEmail(this.customPayload(payload), context);
      default:
        return this.unsupportedTemplate(input.templateKey);
    }
  }

  private context(recipientEmail: string): EmailRenderContext {
    const frontendUrl = normalizeFrontendUrl(
      this.config.get<string>('FRONTEND_URL', 'http://localhost:3000'),
    );
    const assetBaseUrl = this.config
      .get<string>('EMAIL_ASSET_BASE_URL', `${frontendUrl}/email/v1`)
      .replace(/\/$/, '');
    const appName = this.config.get<string>('APP_NAME', 'Xpro');
    return {
      recipientEmail,
      appName,
      logoMark: this.config.get<string>('EMAIL_LOGO_MARK') || monogram(appName),
      frontendUrl,
      assetBaseUrl,
      supportEmail:
        this.config.get<string>('EMAIL_SUPPORT_ADDRESS') || undefined,
      privacyUrl: this.config.get<string>('EMAIL_PRIVACY_URL') || undefined,
      termsUrl: this.config.get<string>('EMAIL_TERMS_URL') || undefined,
      currentYear: new Date().getFullYear(),
    };
  }

  private welcomePayload(
    payload: Record<string, unknown>,
  ): WelcomeEmailPayload {
    return {
      firstName: requiredString(payload, 'firstName'),
    };
  }

  private verificationPayload(
    payload: Record<string, unknown>,
  ): EmailVerificationPayload {
    return {
      code: requiredString(payload, 'code'),
      firstName: optionalString(payload, 'firstName'),
    };
  }

  private passwordResetPayload(
    payload: Record<string, unknown>,
  ): PasswordResetPayload {
    return {
      resetToken: requiredString(payload, 'resetToken'),
      firstName: optionalString(payload, 'firstName'),
    };
  }

  private customPayload(
    payload: Record<string, unknown>,
  ): TrustedCustomEmailPayload {
    return {
      subject: requiredString(payload, 'subject'),
      preheader: optionalString(payload, 'preheader'),
      html: requiredString(payload, 'html'),
      text: requiredString(payload, 'text'),
    };
  }

  private unsupportedTemplate(templateKey: never): never {
    throw new Error(`Unsupported email template: ${String(templateKey)}`);
  }
}
