/**
 * Fail-fast environment validation, run by ConfigModule at boot.
 *
 * Keep REQUIRED_VARS to what the app genuinely cannot start without. Optional
 * subsystems (storage, email in development) validate themselves only once
 * they are switched on, so a fresh clone boots with four variables set.
 */
const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'REDIS_HOST',
  'ENCRYPTION_KEY',
];

const DEV_ENCRYPTION_KEY = 'dev-key-not-for-production-use!!';

const PRODUCTION_EMAIL_VARS = [
  'EMAIL_FROM',
  'EMAIL_FROM_NAME',
  'FRONTEND_URL',
  'EMAIL_ASSET_BASE_URL',
];

const PRODUCTION_SMTP_VARS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
];

const STORAGE_DRIVERS = ['none', 'r2'] as const;
type StorageDriver = (typeof STORAGE_DRIVERS)[number];

const PAYMENT_GATEWAYS = ['paystack', 'test'] as const;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED_VARS.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  const encKey = config['ENCRYPTION_KEY'] as string;
  if (encKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }
  if (encKey === DEV_ENCRYPTION_KEY && config['NODE_ENV'] === 'production') {
    throw new Error(
      'ENCRYPTION_KEY is set to the insecure development default — set a unique secret before starting in production',
    );
  }

  validateStorage(config);
  validatePaymentGateway(config);

  if (config['NODE_ENV'] === 'production') {
    if (String(config['ENABLE_DEV_TOOLS']).toLowerCase() === 'true') {
      throw new Error('ENABLE_DEV_TOOLS must not be enabled in production');
    }

    const missingSmtpVariables = PRODUCTION_SMTP_VARS.filter(
      (key) => typeof config[key] !== 'string' || !String(config[key]).trim(),
    );
    if (missingSmtpVariables.length > 0) {
      throw new Error(
        `Missing required production SMTP variables: ${missingSmtpVariables.join(', ')}`,
      );
    }
    if (![465, 587].includes(Number(config['SMTP_PORT']))) {
      throw new Error('SMTP_PORT must be 465 or 587 in production');
    }

    const missingEmailVariables = PRODUCTION_EMAIL_VARS.filter(
      (key) => !config[key],
    );
    if (missingEmailVariables.length > 0) {
      throw new Error(
        `Missing required production email variables: ${missingEmailVariables.join(', ')}`,
      );
    }

    for (const key of ['FRONTEND_URL', 'EMAIL_ASSET_BASE_URL']) {
      const value = config[key];
      if (typeof value === 'string' && !isHttpsUrl(value)) {
        throw new Error(`${key} must be an absolute HTTPS URL in production`);
      }
    }

    const from = String(config['EMAIL_FROM']).toLowerCase();
    if (from.includes('@example.com')) {
      throw new Error('EMAIL_FROM must not use example.com in production');
    }
  }

  return config;
}

/**
 * `PAYMENT_GATEWAY` defaults to `paystack`. The `test` gateway fakes every
 * charge, so it must never boot in production, and production webhooks and
 * checkouts need the Paystack secret (without it every webhook answers 401).
 */
function validatePaymentGateway(config: Record<string, unknown>): void {
  const raw = config['PAYMENT_GATEWAY'];
  const gateway =
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'paystack';

  if (
    !PAYMENT_GATEWAYS.includes(gateway as (typeof PAYMENT_GATEWAYS)[number])
  ) {
    throw new Error(
      `PAYMENT_GATEWAY must be one of: ${PAYMENT_GATEWAYS.join(', ')}`,
    );
  }
  if (config['NODE_ENV'] !== 'production') return;
  if (gateway === 'test') {
    throw new Error('PAYMENT_GATEWAY must not be "test" in production');
  }
  const secret = config['PAYSTACK_SECRET_KEY'];
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('PAYSTACK_SECRET_KEY is required in production');
  }
}

/**
 * Storage is opt-in. Nothing is checked while STORAGE_DRIVER is unset or
 * `none`, so the app boots without object storage configured. Adding an `s3`
 * driver: see docs/storage/s3.md.
 */
function validateStorage(config: Record<string, unknown>): void {
  const driver = (config['STORAGE_DRIVER'] as string | undefined) ?? 'none';

  if (!STORAGE_DRIVERS.includes(driver as StorageDriver)) {
    throw new Error(
      `STORAGE_DRIVER must be one of: ${STORAGE_DRIVERS.join(', ')}`,
    );
  }

  if (driver === 'none') return;

  const required = [
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_ENDPOINT',
    'STORAGE_PUBLIC_URL',
  ];

  const missingStorage = required.filter((key) => !config[key]);
  if (missingStorage.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=${driver} requires: ${missingStorage.join(', ')}`,
    );
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
