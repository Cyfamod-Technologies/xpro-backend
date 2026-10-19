import type {
  EmailRenderContext,
  RenderedEmail,
  StaffInvitePayload,
} from '../email.types';
import { renderBaseEmail } from './base-email.template';
import {
  renderButton,
  renderHeading,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
} from './components.template';

export function renderStaffInvite(
  payload: StaffInvitePayload,
  context: EmailRenderContext,
): RenderedEmail {
  const inviteUrl = `${context.frontendUrl}/auth/accept-invite?token=${encodeURIComponent(payload.token)}`;
  const greeting = payload.name ? `Hi ${payload.name}, ` : '';
  const subject = `You're invited to join ${context.appName}`;
  const preheader = 'Accept your XPro staff invitation.';
  const footerReason = `You received this email because an XPro administrator invited you to join the staff team.`;
  const content = [
    renderHeading('Your staff invitation'),
    renderParagraph(
      `${greeting}you've been invited to join the ${context.appName} staff team.`,
    ),
    renderButton('Accept invitation', inviteUrl),
    renderNoticePanel(
      'Invitation expires',
      `Accept this invitation by ${new Date(payload.expiresAt).toLocaleString('en', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC.`,
    ),
    renderParagraph(
      'If you were not expecting this invitation, you can ignore this email.',
      20,
    ),
  ].join('');
  return {
    subject,
    preheader,
    html: renderBaseEmail({ preheader, content, context, footerReason }),
    text: [
      `Hello${payload.name ? ` ${payload.name}` : ''},`,
      '',
      `You've been invited to join the ${context.appName} staff team.`,
      `Accept the invitation: ${inviteUrl}`,
      `The invitation expires at ${payload.expiresAt}.`,
      '',
      'If you were not expecting this invitation, you can ignore this email.',
      '',
      renderTextFooter(context, footerReason),
    ].join('\n'),
  };
}
