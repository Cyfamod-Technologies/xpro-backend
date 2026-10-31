import type {
  AccountExistsPayload,
  EmailRenderContext,
  RenderedEmail,
} from '../email.types';
import { buildFrontendUrl } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderButton,
  renderHeading,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
} from './components.template';

const deletionDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});

export function renderAccountExists(
  payload: AccountExistsPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = `You already have an ${context.appName} account`;
  const preheader = 'Someone tried to sign up with this email address.';
  const footerReason =
    'You received this email because someone tried to create an account with this email address.';
  const loginUrl = buildFrontendUrl(context, '/login');
  const resetUrl = buildFrontendUrl(context, '/auth/forgot-password');
  const greeting = payload.firstName ? `Hi ${payload.firstName}, ` : '';
  const deletionDate = payload.deletionScheduledFor
    ? deletionDateFormat.format(new Date(payload.deletionScheduledFor))
    : undefined;
  const deletionMessage = deletionDate
    ? `Sign in before ${deletionDate} to cancel your account deletion.`
    : undefined;
  const content = [
    renderHeading('You already have an account', 'center'),
    renderParagraph(
      `${greeting}${payload.firstName ? 'someone' : 'Someone'} tried to create a new ${context.appName} account with this email address. You already have an account, so nothing was changed.`,
      18,
      'center',
    ),
    renderButton('Sign in', loginUrl),
    renderParagraph(
      'Forgot your password? You can reset it here:',
      24,
      'center',
    ),
    renderButton('Reset password', resetUrl),
    deletionMessage
      ? renderNoticePanel(
          'Your account is scheduled for deletion',
          deletionMessage,
        )
      : '',
    renderParagraph(
      "If this wasn't you, you can ignore this email. Your account is safe.",
      24,
      'center',
    ),
  ].join('');
  const text = [
    payload.firstName ? `Hi ${payload.firstName},` : 'Hello,',
    '',
    `Someone tried to create a new ${context.appName} account with this email address. You already have an account, so nothing was changed.`,
    '',
    `Sign in: ${loginUrl}`,
    '',
    `Forgot your password? Reset it here: ${resetUrl}`,
    '',
    ...(deletionMessage
      ? ['Your account is scheduled for deletion.', deletionMessage, '']
      : []),
    "If this wasn't you, you can ignore this email. Your account is safe.",
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
