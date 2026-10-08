import type {
  EmailRenderContext,
  PasswordResetPayload,
  RenderedEmail,
} from '../email.types';
import { buildFrontendUrl } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderButton,
  renderFallbackUrl,
  renderHeading,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
} from './components.template';

export function renderPasswordReset(
  payload: PasswordResetPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = `Reset your ${context.appName} password`;
  const preheader = 'This password reset link expires in one hour.';
  const footerReason =
    'You received this email because a password reset was requested for your account.';
  const resetUrl = buildFrontendUrl(context, '/reset-password', {
    token: payload.resetToken,
  });
  const greeting = payload.firstName ? `Hi ${payload.firstName}, ` : '';
  const content = [
    renderHeading('Reset your password'),
    renderParagraph(
      `${greeting}we received a request to reset your ${context.appName} password. Use the secure link below to choose a new password.`,
    ),
    renderButton('Reset password', resetUrl),
    renderFallbackUrl(resetUrl),
    renderNoticePanel(
      'Security notice',
      'This password reset link expires in 1 hour and can be used only once.',
    ),
    renderParagraph(
      "If you didn't request a password reset, no action is required. Your password will remain unchanged.",
      24,
    ),
  ].join('');
  const text = [
    payload.firstName ? `Hi ${payload.firstName},` : 'Hello,',
    '',
    `We received a request to reset your ${context.appName} password.`,
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'This link expires in 1 hour and can be used only once.',
    '',
    "If you didn't request a password reset, no action is required.",
    '',
    renderTextFooter(context, footerReason),
  ].join('\n');
  return {
    subject,
    preheader,
    html: renderBaseEmail({
      preheader,
      content,
      context,
      footerReason,
    }),
    text,
  };
}
