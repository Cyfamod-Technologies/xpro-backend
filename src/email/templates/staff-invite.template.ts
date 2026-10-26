import type {
  EmailRenderContext,
  RenderedEmail,
  StaffInvitePayload,
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

export function renderStaffInvite(
  payload: StaffInvitePayload,
  context: EmailRenderContext,
): RenderedEmail {
  const inviteUrl = buildFrontendUrl(context, '/auth/accept-invite', {
    token: payload.token,
  });
  const greeting = payload.name ? `Hi ${payload.name}, ` : '';
  const subject = `You're invited to join ${context.appName}`;
  const preheader = `Accept your ${context.appName} staff invitation.`;
  const footerReason = `You received this email because an administrator invited you to join the ${context.appName} staff team.`;
  const content = [
    renderHeading(`Join the ${context.appName} team`, 'center'),
    renderParagraph(
      `${greeting}you've been invited to join the ${context.appName} staff team.`,
      18,
      'center',
    ),
    renderParagraph(
      'This invitation gives you access to the staff dashboard, where you can collaborate and manage team activities.',
      14,
      'center',
    ),
    renderButton('Accept invitation', inviteUrl),
    renderFallbackUrl(inviteUrl),
    renderNoticePanel(
      'Invitation expires',
      `Accept this invitation by ${new Date(payload.expiresAt).toLocaleString('en', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC.`,
    ),
    renderParagraph(
      'If you were not expecting this invitation, you can ignore this email.',
      20,
      'center',
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
