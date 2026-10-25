import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EmailRenderContext,
  EmailTemplateKey,
  EmailVerificationPayload,
  PasswordResetPayload,
  RenderedEmail,
  RequestUpdatePayload,
  StaffInvitePayload,
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
import { renderRequestUpdate } from './templates/request-update.template';
import { renderStaffInvite } from './templates/staff-invite.template';

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
      case 'staff_invite':
        return renderStaffInvite(this.staffInvitePayload(payload), context);
      case 'request_update':
        return renderRequestUpdate(this.requestUpdatePayload(payload), context);
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
      logoUrl: `${frontendUrl}/images/xpro-logo-transparent.png`,
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
      token: requiredString(payload, 'token'),
      firstName: optionalString(payload, 'firstName'),
    };
  }

  private staffInvitePayload(
    payload: Record<string, unknown>,
  ): StaffInvitePayload {
    return {
      name: requiredString(payload, 'name'),
      token: requiredString(payload, 'token'),
      expiresAt: requiredString(payload, 'expiresAt'),
    };
  }

  private requestUpdatePayload(
    payload: Record<string, unknown>,
  ): RequestUpdatePayload {
    return {
      title: requiredString(payload, 'title'),
      message: requiredString(payload, 'message'),
      link: optionalString(payload, 'link'),
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
