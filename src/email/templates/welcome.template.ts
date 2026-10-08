import type {
  EmailRenderContext,
  RenderedEmail,
  WelcomeEmailPayload,
} from '../email.types';
import { buildFrontendUrl, emailSubjectValue } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderButton,
  renderHeading,
  renderParagraph,
  renderTextFooter,
} from './components.template';

export function renderWelcomeEmail(
  payload: WelcomeEmailPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = `Welcome to ${context.appName}, ${emailSubjectValue(payload.firstName)}`;
  const preheader = `Your ${context.appName} account is ready.`;
  const dashboardUrl = buildFrontendUrl(context, '/dashboard');
  const footerReason = 'You received this email after verifying your account.';
  const content = [
    renderHeading(`Welcome to ${context.appName}`),
    renderParagraph(
      `Hi ${payload.firstName}, your account is verified and ready to use.`,
    ),
    renderParagraph(
      'Head to your dashboard to finish setting things up. If you run into anything, just reply to this email.',
    ),
    renderButton('Go to your dashboard', dashboardUrl),
    renderParagraph(`See you inside,\nThe ${context.appName} team`, 24),
  ].join('');
  const text = [
    `Hi ${payload.firstName},`,
    '',
    `Welcome to ${context.appName}. Your account is verified and ready to use.`,
    '',
    `Go to your dashboard: ${dashboardUrl}`,
    '',
    `The ${context.appName} team`,
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
