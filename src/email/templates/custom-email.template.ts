import type {
  EmailRenderContext,
  RenderedEmail,
  TrustedCustomEmailPayload,
} from '../email.types';
import { renderBaseEmail } from './base-email.template';
import { renderTextFooter } from './components.template';

export function renderTrustedCustomEmail(
  payload: TrustedCustomEmailPayload,
  context: EmailRenderContext,
): RenderedEmail {
  const preheader = payload.preheader || payload.subject;
  return {
    subject: payload.subject,
    preheader,
    html: renderBaseEmail({
      preheader,
      content: payload.html,
      context,
    }),
    text: `${payload.text}\n\n${renderTextFooter(context)}`,
  };
}
