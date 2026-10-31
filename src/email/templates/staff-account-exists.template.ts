import type {
  EmailRenderContext,
  RenderedEmail,
  StaffAccountExistsPayload,
} from '../email.types';
import { renderBaseEmail } from './base-email.template';
import {
  renderHeading,
  renderParagraph,
  renderTextFooter,
} from './components.template';

export function renderStaffAccountExists(
  payload: StaffAccountExistsPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = `This email is used by an ${context.appName} staff account`;
  const preheader = 'No new account was created.';
  const footerReason =
    'You received this email because someone tried to create an account with this email address.';
  const greeting = payload.firstName ? `Hi ${payload.firstName}, ` : '';
  const content = [
    renderHeading('This email belongs to a staff account', 'center'),
    renderParagraph(
      `${greeting}${payload.firstName ? 'someone' : 'Someone'} tried to create a customer or provider account with this email address. It is used by an ${context.appName} staff account, so no new account was created.`,
      18,
      'center',
    ),
    renderParagraph(
      'Use a different email address for a customer or provider account.',
      16,
      'center',
    ),
    renderParagraph(
      "If this wasn't you, you can ignore this email.",
      24,
      'center',
    ),
  ].join('');
  const text = [
    payload.firstName ? `Hi ${payload.firstName},` : 'Hello,',
    '',
    `Someone tried to create a customer or provider account with this email address. It is used by an ${context.appName} staff account, so no new account was created.`,
    '',
    'Use a different email address for a customer or provider account.',
    '',
    "If this wasn't you, you can ignore this email.",
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
