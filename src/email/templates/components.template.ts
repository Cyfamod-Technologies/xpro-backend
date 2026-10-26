import { EMAIL_COLORS, EMAIL_FONT_STACK } from '../email-brand.constants';
import type { EmailRenderContext } from '../email.types';
import { escapeHtml } from '../email-template.utils';

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'destructive';

export function renderLogo(context: EmailRenderContext): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center" valign="middle">
          <img src="${escapeHtml(context.logoUrl)}" width="220" alt="${escapeHtml(context.appName)}" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />
        </td>
      </tr>
    </table>`;
}

export function renderHeading(
  title: string,
  align: 'left' | 'center' = 'left',
): string {
  return `<h1 class="email-heading" style="margin:0;color:${EMAIL_COLORS.foreground};font-family:${EMAIL_FONT_STACK};font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.5px;text-align:${align};">${escapeHtml(title)}</h1>`;
}

export function renderParagraph(
  content: string,
  marginTop = 16,
  align: 'left' | 'center' = 'left',
): string {
  return `<p style="margin:${marginTop}px 0 0;color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:24px;font-weight:400;text-align:${align};">${escapeHtml(content).replace(/\n/g, '<br />')}</p>`;
}

export function renderRichParagraph(content: string, marginTop = 16): string {
  return `<p style="margin:${marginTop}px 0 0;color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:26px;font-weight:400;">${content}</p>`;
}

export function renderButton(label: string, href: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:28px;border-collapse:collapse;">
      <tr>
        <td align="center" bgcolor="${EMAIL_COLORS.primary}" style="border-radius:12px;background-color:${EMAIL_COLORS.primary};mso-padding-alt:14px 24px;">
          <!--[if mso]>
          <v:roundrect href="${safeHref}" style="height:48px;v-text-anchor:middle;width:488px;" arcsize="25%" stroke="f" fillcolor="${EMAIL_COLORS.primary}">
            <w:anchorlock/>
            <center style="color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;">${safeLabel}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a class="email-button-link" href="${safeHref}" target="_blank" rel="noopener noreferrer" style="display:block;padding:14px 24px;border-radius:12px;background-color:${EMAIL_COLORS.primary};color:#FFFFFF !important;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:20px;font-weight:700;text-align:center;text-decoration:none !important;"><span style="color:#FFFFFF;">${safeLabel}</span></a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

export function renderFallbackUrl(href: string): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${EMAIL_COLORS.muted}" style="width:100%;margin-top:16px;border:1px solid ${EMAIL_COLORS.border};border-radius:12px;">
      <tr>
        <td style="padding:14px 16px;">
          <p style="margin:0 0 4px;color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:18px;font-weight:600;">Button not working?</p>
          <p style="margin:0;word-break:break-all;color:${EMAIL_COLORS.primary};font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:18px;"><a href="${escapeHtml(href)}" style="color:${EMAIL_COLORS.primary};text-decoration:underline;">${escapeHtml(href)}</a></p>
        </td>
      </tr>
    </table>`;
}

export function renderNoticePanel(
  title: string,
  message: string,
  tone: NoticeTone = 'neutral',
): string {
  const tones: Record<NoticeTone, { background: string; accent: string }> = {
    neutral: {
      background: EMAIL_COLORS.muted,
      accent: EMAIL_COLORS.primary,
    },
    success: {
      background: EMAIL_COLORS.successSoft,
      accent: EMAIL_COLORS.success,
    },
    warning: {
      background: EMAIL_COLORS.warningSoft,
      accent: EMAIL_COLORS.warning,
    },
    destructive: {
      background: EMAIL_COLORS.destructiveSoft,
      accent: EMAIL_COLORS.destructive,
    },
  };
  const colors = tones[tone];
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${colors.background}" style="width:100%;margin-top:24px;border:1px solid ${EMAIL_COLORS.border};border-radius:12px;">
      <tr>
        <td width="48" valign="top" style="width:48px;padding:16px 0 16px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td width="28" height="28" align="center" valign="middle" bgcolor="#FFFFFF" style="width:28px;height:28px;border:1px solid ${colors.accent};border-radius:999px;color:${colors.accent};font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:28px;font-weight:700;">i</td>
            </tr>
          </table>
        </td>
        <td valign="top" style="padding:16px 16px 16px 10px;">
          <p style="margin:0;color:${EMAIL_COLORS.foreground};font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:19px;font-weight:700;">${escapeHtml(title)}</p>
          <p style="margin:4px 0 0;color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:20px;">${escapeHtml(message)}</p>
        </td>
      </tr>
    </table>`;
}

export function renderStatusBadge(
  label: string,
  tone: 'primary' | 'success' | 'warning',
): string {
  const tones = {
    primary: {
      background: '#EEF2FF',
      foreground: EMAIL_COLORS.primary,
    },
    success: {
      background: EMAIL_COLORS.successSoft,
      foreground: EMAIL_COLORS.success,
    },
    warning: {
      background: EMAIL_COLORS.warningSoft,
      foreground: '#9A6100',
    },
  } as const;
  const colors = tones[tone];
  return `<span style="display:inline-block;padding:7px 12px;border-radius:999px;background:${colors.background};color:${colors.foreground};font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:16px;font-weight:700;">${escapeHtml(label)}</span>`;
}

export function renderDetailRows(
  rows: Array<{ label: string; value: string }>,
): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${EMAIL_COLORS.muted}" style="margin-top:24px;border:1px solid ${EMAIL_COLORS.border};border-radius:16px;">
      ${rows
        .map(
          (row, index) => `
          <tr>
            <td style="padding:${index === 0 ? '18px 18px 12px' : '12px 18px'};${index < rows.length - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.border};` : ''}color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:20px;font-weight:600;">${escapeHtml(row.label)}</td>
            <td align="right" style="padding:${index === 0 ? '18px 18px 12px' : '12px 18px'};${index < rows.length - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.border};` : ''}color:${EMAIL_COLORS.foreground};font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:20px;font-weight:700;">${escapeHtml(row.value)}</td>
          </tr>`,
        )
        .join('')}
    </table>`;
}

export function renderBenefitRows(items: string[]): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;">
      ${items
        .map(
          (item) => `
          <tr>
            <td width="28" valign="top" style="padding:7px 0;color:${EMAIL_COLORS.success};font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:22px;font-weight:700;">✓</td>
            <td style="padding:7px 0;color:${EMAIL_COLORS.foreground};font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:22px;font-weight:600;">${escapeHtml(item)}</td>
          </tr>`,
        )
        .join('')}
    </table>`;
}

export function renderIllustration(
  src: string,
  alt: string,
  width: number,
  height: number,
): string {
  return `
    <div style="margin-top:28px;">
      <img src="${escapeHtml(src)}" width="${width}" height="${height}" alt="${escapeHtml(alt)}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;border-radius:20px;" />
    </div>`;
}

export function renderFooter(
  context: EmailRenderContext,
  reason?: string,
): string {
  const links: string[] = [];
  if (context.privacyUrl) {
    links.push(
      `<a href="${escapeHtml(context.privacyUrl)}" style="color:${EMAIL_COLORS.mutedForeground};text-decoration:underline;">Privacy</a>`,
    );
  }
  if (context.termsUrl) {
    links.push(
      `<a href="${escapeHtml(context.termsUrl)}" style="color:${EMAIL_COLORS.mutedForeground};text-decoration:underline;">Terms</a>`,
    );
  }
  const support = context.supportEmail
    ? `<p style="margin:6px 0 0;">Need help? <a href="mailto:${escapeHtml(context.supportEmail)}" style="color:${EMAIL_COLORS.primary};text-decoration:underline;">${escapeHtml(context.supportEmail)}</a></p>`
    : '';
  const linkRow =
    links.length > 0
      ? `<p style="margin:6px 0 0;">${links.join(' &nbsp;·&nbsp; ')}</p>`
      : '';
  const reasonRow = reason
    ? `<p style="margin:0 0 6px;">${escapeHtml(reason)}</p>`
    : '';
  return `
    <div style="padding:20px 12px 0;color:${EMAIL_COLORS.mutedForeground};font-family:${EMAIL_FONT_STACK};font-size:11px;line-height:18px;text-align:center;">
      ${reasonRow}
      <p style="margin:0;">© ${context.currentYear} ${escapeHtml(context.appName)}. All rights reserved.</p>
      ${support}
      ${linkRow}
    </div>`;
}

export function renderTextFooter(
  context: EmailRenderContext,
  reason?: string,
): string {
  return [
    reason,
    `© ${context.currentYear} ${context.appName}. All rights reserved.`,
    context.supportEmail ? `Support: ${context.supportEmail}` : undefined,
    context.privacyUrl ? `Privacy: ${context.privacyUrl}` : undefined,
    context.termsUrl ? `Terms: ${context.termsUrl}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}
