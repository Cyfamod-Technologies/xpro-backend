import type {
  EmailRenderContext,
  RenderedEmail,
  RequestUpdatePayload,
} from '../email.types';
import { emailSubjectValue, buildFrontendUrl } from '../email-template.utils';
import { renderBaseEmail } from './base-email.template';
import {
  renderButton,
  renderHeading,
  renderNoticePanel,
  renderParagraph,
  renderTextFooter,
} from './components.template';

function linkUrl(
  link: string | undefined,
  context: EmailRenderContext,
): string | undefined {
  if (!link || !link.startsWith('/') || link.startsWith('//')) {
    return undefined;
  }
  return buildFrontendUrl(context, link);
}

export function renderRequestUpdate(
  payload: RequestUpdatePayload,
  context: EmailRenderContext,
): RenderedEmail {
  const subject = emailSubjectValue(payload.title);
  const preheader = payload.message;
  const url = linkUrl(payload.link, context);
  const footerReason = `You received this email because of an update on your ${context.appName} account.`;
  const content = [
    renderHeading(payload.title),
    renderNoticePanel('Request update', payload.message),
    renderParagraph(
      `You can view the latest details in your ${context.appName} account.`,
      18,
    ),
    url ? renderButton('View request', url) : '',
  ].join('');
  return {
    subject,
    preheader,
    html: renderBaseEmail({ preheader, content, context, footerReason }),
    text: [
      payload.title,
      '',
      payload.message,
      ...(url ? ['', `View request: ${url}`] : []),
      '',
      renderTextFooter(context, footerReason),
    ].join('\n'),
  };
}
