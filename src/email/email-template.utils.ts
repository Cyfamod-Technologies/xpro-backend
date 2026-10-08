import type { EmailRenderContext } from './email.types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function asPayloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Email template payload must be an object');
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Email template payload is missing ${key}`);
  }
  return value;
}

export function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

export function emailSubjectValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function normalizeFrontendUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}

export function buildFrontendUrl(
  context: EmailRenderContext,
  path: string,
  query?: Record<string, string>,
): string {
  const base = context.frontendUrl.endsWith('/')
    ? context.frontendUrl
    : `${context.frontendUrl}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildAssetUrl(
  context: EmailRenderContext,
  filename: string,
): string {
  const base = context.assetBaseUrl.endsWith('/')
    ? context.assetBaseUrl
    : `${context.assetBaseUrl}/`;
  return new URL(filename.replace(/^\//, ''), base).toString();
}

export function formatEmailDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Email template payload contains an invalid date');
  }
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}

export function humanizeEnum(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
