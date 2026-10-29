import type {
  EmailRenderContext,
  EmailVerificationPayload,
  RenderedEmail,
} from '../email.types';
import { buildFrontendUrl } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderHeading,
  renderButton,
  renderFallbackUrl,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
} from './components.template';

export function renderEmailVerification(
  payload: EmailVerificationPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = `Verify your ${context.appName} email`;
  const verificationUrl = buildFrontendUrl(context, '/auth/verify-email', {
    token: payload.token,
  });
  const preheader = 'Confirm your email address to activate your account.';
  const footerReason = `You received this email because a ${context.appName} account was created with this address.`;
  const greeting = payload.firstName ? `Hi ${payload.firstName}, ` : '';
  const content = [
    renderHeading('Check your inbox', 'center'),
    renderParagraph(
      `${greeting}we've sent a verification link to confirm your ${context.appName} account email address.`,
      18,
      'center',
    ),
    renderButton('Verify email address', verificationUrl),
    renderFallbackUrl(verificationUrl),
    renderParagraph('Keep this verification link private.', 18, 'center'),
    renderNoticePanel(
      'Link expiry',
      'This verification link expires in 24 hours.',
    ),
    renderParagraph(
      "If you didn't create this account, you can safely ignore this email.",
      20,
      'center',
    ),
  ].join('');
  const text = [
    payload.firstName ? `Hi ${payload.firstName},` : 'Hello,',
    '',
    `Confirm this email address to finish setting up your ${context.appName} account.`,
    '',
    `Verification link: ${verificationUrl}`,
    '',
    'This verification link expires in 24 hours. Do not share it with anyone.',
    '',
    "If you didn't create this account, you can safely ignore this email.",
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
