import type {
  EmailRenderContext,
  RenderedEmail,
  WelcomeEmailPayload,
} from '../email.types';
import { buildFrontendUrl, emailSubjectValue } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderBenefitRows,
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
    renderHeading(`Welcome to ${context.appName}`, 'center'),
    renderParagraph(
      `Hi ${payload.firstName}, we're glad you're here. Your account is ready to use.`,
      18,
      'center',
    ),
    renderParagraph(
      `Request a service, work with trusted professionals, and follow progress from your ${context.appName} account.`,
      14,
      'center',
    ),
    renderButton(`Explore ${context.appName}`, dashboardUrl),
    renderBenefitRows([
      'Request the service you need',
      'Work with trusted professionals',
      'Track progress in your account',
    ]),
    renderParagraph(
      `See you inside,\nThe ${context.appName} team`,
      24,
      'center',
    ),
  ].join('');
  const text = [
    `Hi ${payload.firstName},`,
    '',
    `Welcome to ${context.appName}. Your account is verified and ready to use.`,
    '',
    `Explore ${context.appName}: ${dashboardUrl}`,
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
