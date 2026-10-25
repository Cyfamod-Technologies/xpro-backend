import { validateEnv } from './env.validation';

describe('validateEnv SMTP requirements', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://xpro:secret@postgres:5432/xpro',
    JWT_SECRET: 'test-secret',
    REDIS_HOST: 'redis',
    ENCRYPTION_KEY: 'a'.repeat(32),
    PAYSTACK_SECRET_KEY: 'sk_live_example',
    SMTP_HOST: 'smtp.hostinger.com',
    SMTP_PORT: '465',
    SMTP_USER: 'noreply@xpro.example',
    SMTP_PASSWORD: 'mailbox-password',
    EMAIL_FROM: 'noreply@xpro.example',
    EMAIL_FROM_NAME: 'Xpro',
    FRONTEND_URL: 'https://app.xpro.example',
    EMAIL_ASSET_BASE_URL: 'https://app.xpro.example/email/v1',
  };

  it('accepts a complete Hostinger SMTP configuration', () => {
    expect(validateEnv(productionEnv)).toBe(productionEnv);
  });

  it('requires SMTP credentials in production', () => {
    expect(() => validateEnv({ ...productionEnv, SMTP_PASSWORD: ' ' })).toThrow(
      'Missing required production SMTP variables: SMTP_PASSWORD',
    );
  });

  it('rejects ports other than 465 and 587 in production', () => {
    expect(() => validateEnv({ ...productionEnv, SMTP_PORT: '25' })).toThrow(
      'SMTP_PORT must be 465 or 587 in production',
    );
  });

  it('keeps SMTP optional for development', () => {
    expect(
      validateEnv({
        ...productionEnv,
        NODE_ENV: 'development',
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
      }),
    ).toBeDefined();
  });

  it('rejects ENABLE_DEV_TOOLS=true in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, ENABLE_DEV_TOOLS: 'true' }),
    ).toThrow('ENABLE_DEV_TOOLS must not be enabled in production');
    expect(
      validateEnv({ ...productionEnv, ENABLE_DEV_TOOLS: 'false' }),
    ).toBeDefined();
  });

  it.each(['127.0.0.1', 'localhost', '::1'])(
    'rejects REDIS_HOST=%s in production',
    (host) => {
      expect(() => validateEnv({ ...productionEnv, REDIS_HOST: host })).toThrow(
        'REDIS_HOST must not be a loopback address in production',
      );
    },
  );

  it('rejects a loopback DATABASE_URL host in production', () => {
    expect(() =>
      validateEnv({
        ...productionEnv,
        DATABASE_URL: 'postgresql://xpro:secret@127.0.0.1:5432/xpro',
      }),
    ).toThrow(
      'DATABASE_URL must not point at a loopback address in production',
    );
  });

  it('allows loopback Redis and Postgres outside production', () => {
    expect(
      validateEnv({
        ...productionEnv,
        NODE_ENV: 'development',
        REDIS_HOST: '127.0.0.1',
        DATABASE_URL: 'postgresql://xpro:secret@localhost:5432/xpro',
      }),
    ).toBeDefined();
  });

  it('allows ENABLE_DEV_TOOLS=true outside production', () => {
    expect(
      validateEnv({
        ...productionEnv,
        NODE_ENV: 'development',
        ENABLE_DEV_TOOLS: 'true',
      }),
    ).toBeDefined();
  });
});

describe('validateEnv payment gateway', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://localhost/xpro',
    JWT_SECRET: 'test-secret',
    REDIS_HOST: 'localhost',
    ENCRYPTION_KEY: 'a'.repeat(32),
  };
  const productionEnv = {
    ...baseEnv,
    NODE_ENV: 'production',
    SMTP_HOST: 'smtp.hostinger.com',
    SMTP_PORT: '465',
    SMTP_USER: 'noreply@xpro.example',
    SMTP_PASSWORD: 'mailbox-password',
    EMAIL_FROM: 'noreply@xpro.example',
    EMAIL_FROM_NAME: 'Xpro',
    FRONTEND_URL: 'https://app.xpro.example',
    EMAIL_ASSET_BASE_URL: 'https://app.xpro.example/email/v1',
    PAYSTACK_SECRET_KEY: 'sk_live_example',
  };

  it('defaults to paystack and accepts paystack or test in development', () => {
    expect(validateEnv({ ...baseEnv, NODE_ENV: 'development' })).toBeDefined();
    expect(
      validateEnv({ ...baseEnv, PAYMENT_GATEWAY: 'paystack' }),
    ).toBeDefined();
    expect(validateEnv({ ...baseEnv, PAYMENT_GATEWAY: 'test' })).toBeDefined();
  });

  it('rejects any other gateway name', () => {
    expect(() =>
      validateEnv({ ...baseEnv, PAYMENT_GATEWAY: 'flutterwave' }),
    ).toThrow('PAYMENT_GATEWAY must be one of: paystack, test');
  });

  it('rejects the test gateway in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, PAYMENT_GATEWAY: 'test' }),
    ).toThrow('PAYMENT_GATEWAY must not be "test" in production');
  });

  it('requires PAYSTACK_SECRET_KEY in production', () => {
    expect(() =>
      validateEnv({ ...productionEnv, PAYSTACK_SECRET_KEY: undefined }),
    ).toThrow('PAYSTACK_SECRET_KEY is required in production');
    expect(() =>
      validateEnv({ ...productionEnv, PAYSTACK_SECRET_KEY: '  ' }),
    ).toThrow('PAYSTACK_SECRET_KEY is required in production');
  });

  it('accepts a production paystack configuration', () => {
    expect(
      validateEnv({ ...productionEnv, PAYMENT_GATEWAY: 'paystack' }),
    ).toBeDefined();
    expect(validateEnv(productionEnv)).toBeDefined();
  });

  it('does not need a Paystack secret outside production', () => {
    expect(validateEnv({ ...baseEnv, NODE_ENV: 'development' })).toBeDefined();
  });
});
