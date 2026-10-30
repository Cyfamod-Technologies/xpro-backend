import type { Prisma } from '@prisma/client';
import { SETTINGS_REGISTRY } from '../platform/settings/settings.registry';

export const PROVIDER_PHONE_VERIFICATION_SETTING =
  'provider.requirePhoneVerification';

export async function requiresProviderPhoneVerification(
  db: Pick<Prisma.TransactionClient, 'setting'>,
): Promise<boolean> {
  const setting = await db.setting.findUnique({
    where: { key: PROVIDER_PHONE_VERIFICATION_SETTING },
  });
  return (
    (setting?.value ??
      SETTINGS_REGISTRY[PROVIDER_PHONE_VERIFICATION_SETTING].defaultValue) ===
    true
  );
}

export const PROVIDER_EMAIL_VERIFICATION_SETTING =
  'provider.requireEmailVerification';

export async function requiresProviderEmailVerification(
  db: Pick<Prisma.TransactionClient, 'setting'>,
): Promise<boolean> {
  const setting = await db.setting.findUnique({
    where: { key: PROVIDER_EMAIL_VERIFICATION_SETTING },
  });
  return (
    (setting?.value ??
      SETTINGS_REGISTRY[PROVIDER_EMAIL_VERIFICATION_SETTING].defaultValue) ===
    true
  );
}
