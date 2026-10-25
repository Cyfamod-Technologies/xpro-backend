/**
 * Email palette. Inline styles are required for mail-client support, so these
 * constants are the single place to restyle every template.
 *
 * The product *name* is not here — it comes from APP_NAME via
 * EmailRenderContext, so it can differ per environment.
 */
export const EMAIL_COLORS = {
  canvas: '#102A3A',
  card: '#FFFFFF',
  foreground: '#102A3A',
  primary: '#4AA7DF',
  secondary: '#526A82',
  muted: '#F2F7FB',
  mutedForeground: '#526A82',
  border: '#DCE7EF',
  success: '#2E8B68',
  successSoft: '#EAF6F1',
  warning: '#E68F3C',
  warningSoft: '#FFF5E9',
  destructive: '#E64449',
  destructiveSoft: '#FFF0F0',
} as const;

export const EMAIL_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif";
