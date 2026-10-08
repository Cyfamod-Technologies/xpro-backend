import { EMAIL_COLORS, EMAIL_FONT_STACK } from '../email-brand.constants';
import type { EmailRenderContext } from '../email.types';
import { escapeHtml } from '../email-template.utils';
import { renderFooter, renderLogo } from './components.template';

interface BaseEmailInput {
  preheader: string;
  content: string;
  context: EmailRenderContext;
  footerReason?: string;
}

export function renderBaseEmail(input: BaseEmailInput): string {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(input.preheader)}</title>
    <style>
      body { margin: 0 !important; padding: 0 !important; background: ${EMAIL_COLORS.canvas}; }
      table { border-collapse: separate; mso-table-lspace: 0; mso-table-rspace: 0; }
      img { border: 0; outline: none; text-decoration: none; }
      a { color: ${EMAIL_COLORS.primary}; }
      .email-button-link { color: #FFFFFF !important; text-decoration: none !important; }
      a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
      @media screen and (max-width: 620px) {
        .email-outer { padding: 20px 12px !important; }
        .email-card { padding: 28px 20px !important; }
        .email-heading { font-size: 25px !important; line-height: 32px !important; }
        .email-code-cell { width: 34px !important; height: 44px !important; font-size: 18px !important; line-height: 22px !important; }
        .email-code-gap { width: 5px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${EMAIL_COLORS.canvas};font-family:${EMAIL_FONT_STACK};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${EMAIL_COLORS.canvas}">
      <tr>
        <td class="email-outer" align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="padding:0 4px 18px;">${renderLogo(input.context)}</td>
            </tr>
            <tr>
              <td class="email-card" bgcolor="${EMAIL_COLORS.card}" style="padding:36px;border:1px solid ${EMAIL_COLORS.border};border-top:3px solid ${EMAIL_COLORS.primary};border-radius:20px;box-shadow:0 16px 44px rgba(27,30,46,0.07);">
                ${input.content}
              </td>
            </tr>
            <tr>
              <td>${renderFooter(input.context, input.footerReason)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
