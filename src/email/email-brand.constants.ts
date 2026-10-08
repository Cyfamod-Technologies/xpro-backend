/**
 * Email palette. Inline styles are required for mail-client support, so these
 * constants are the single place to restyle every template.
 *
 * The product *name* is not here — it comes from APP_NAME via
 * EmailRenderContext, so it can differ per environment.
 */
export const EMAIL_COLORS = {
  canvas: '#F4F5F7',
  card: '#FFFFFF',
  foreground: '#18181B',
  primary: '#2563EB',
  secondary: '#4F46E5',
  muted: '#FAFAFA',
  mutedForeground: '#64748B',
  border: '#E4E4E7',
  success: '#059669',
  successSoft: '#ECFDF5',
  warning: '#D97706',
  warningSoft: '#FFFBEB',
  destructive: '#DC2626',
  destructiveSoft: '#FEF2F2',
} as const;

export const EMAIL_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, Helvetica, sans-serif';
