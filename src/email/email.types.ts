export const EMAIL_TEMPLATE_KEYS = [
  'welcome',
  'email_verification',
  'password_reset',
  'custom_email',
  'staff_invite',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export interface WelcomeEmailPayload {
  firstName: string;
}

export interface EmailVerificationPayload {
  code?: string;
  token?: string;
  firstName?: string;
}

export interface PasswordResetPayload {
  resetToken: string;
  firstName?: string;
}

export interface StaffInvitePayload {
  name: string;
  token: string;
  expiresAt: string;
}

/**
 * Pre-rendered HTML/text supplied by trusted server-side callers only. Never
 * populate this from user input — the body is injected into the email shell
 * without escaping.
 */
export interface TrustedCustomEmailPayload {
  subject: string;
  preheader?: string;
  html: string;
  text: string;
}

export interface EmailTemplatePayloadMap {
  welcome: WelcomeEmailPayload;
  email_verification: EmailVerificationPayload;
  password_reset: PasswordResetPayload;
  custom_email: TrustedCustomEmailPayload;
  staff_invite: StaffInvitePayload;
}

export interface EmailRenderContext {
  recipientEmail: string;
  /** Product name shown in the logo lockup, subjects and footers. */
  appName: string;
  /** 1-3 character monogram rendered in the logo tile. */
  logoMark: string;
  frontendUrl: string;
  assetBaseUrl: string;
  supportEmail?: string;
  privacyUrl?: string;
  termsUrl?: string;
  currentYear: number;
}

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export interface QueuedEmail {
  notificationId: string;
  recipientEmail: string;
  templateKey: EmailTemplateKey;
  payload: Record<string, unknown>;
}

export interface EmailJobData {
  notificationId: string;
  recipientEmail: string;
  recipientUserId?: string;
  type: string;
  templateKey: EmailTemplateKey;
  payload: Record<string, unknown>;
}

export interface SentEmailResult {
  /** Identifier of the transport that accepted the message, for log tracing. */
  provider: string;
  id?: string;
  response: unknown;
}
