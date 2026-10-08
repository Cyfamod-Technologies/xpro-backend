import type {
  EmailRenderContext,
  EmailVerificationPayload,
  RenderedEmail,
} from '../email.types';
import { renderBaseEmail } from './base-email.template';
import {
  renderHeading,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
  renderVerificationCode,
} from './components.template';

export function renderEmailVerification(
  payload: EmailVerificationPayload,
  context: EmailRenderContext,
): RenderedEmail {
  if (!/^\d{6}$/.test(payload.code)) {
    throw new Error('Email verification code must be six digits');
  }
  const subject = `Verify your ${context.appName} email`;
  const preheader = 'Use your six-digit code to activate your account.';
  const footerReason = `You received this email because a ${context.appName} account was created with this address.`;
  const greeting = payload.firstName ? `Hi ${payload.firstName}, ` : '';
  const content = [
    renderHeading('Verify your email'),
    renderParagraph(
      `${greeting}confirm this email address to finish setting up your ${context.appName} account.`,
    ),
    renderVerificationCode(payload.code),
    renderParagraph(
      `Enter this code in ${context.appName} to verify your email address.`,
      20,
    ),
    renderNoticePanel(
      'Keep this code private',
      `It expires in 24 hours. ${context.appName} will never ask you to share it by email or chat.`,
    ),
    renderParagraph(
      "If you didn't create this account, you can safely ignore this email.",
      20,
    ),
  ].join('');
  const text = [
    payload.firstName ? `Hi ${payload.firstName},` : 'Hello,',
    '',
    `Confirm this email address to finish setting up your ${context.appName} account.`,
    '',
    `Verification code: ${payload.code}`,
    `Enter this six-digit code in ${context.appName} to verify your email address.`,
    '',
    'This verification code expires in 24 hours. Do not share it with anyone.',
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
