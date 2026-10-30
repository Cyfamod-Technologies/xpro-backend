import { isPhoneNumber } from 'class-validator';

export function normalizeAccountPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const national = compact.replace(/^(?:\+234|234|0)/, '');
  if (!/^\d{10}$/.test(national)) return null;
  const normalized = `+234${national}`;
  return isPhoneNumber(normalized, 'NG') ? normalized : null;
}
