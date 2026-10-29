import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ProvidersService } from './providers.service';

const BANKS = [{ code: '058', name: 'GTBank' }];

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function setup(options: { failGet?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) =>
      options.failGet
        ? Promise.reject(new Error('redis down'))
        : Promise.resolve(store.get(key) ?? null),
    ),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  };
  const prisma = {
    providerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
  };
  const config = { get: jest.fn().mockReturnValue('sk_test') };
  const service = new ProvidersService(
    prisma as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    redis as never,
  );
  jest
    .spyOn(service as never, 'requireProvider' as never)
    .mockResolvedValue({} as never);
  const resolve = () =>
    service.resolveBankForProvider('user-1', {
      bankCode: '058',
      accountNumber: '0123456789',
    });
  return { redis, resolve };
}

describe('ProvidersService bank resolve', () => {
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL]>();
  const originalFetch = global.fetch;
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.ENCRYPTION_KEY = originalKey;
    jest.restoreAllMocks();
  });

  const paystack = (resolveResponse: Response) =>
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        urlOf(url).includes('/bank/resolve')
          ? resolveResponse
          : jsonResponse(200, { data: BANKS }),
      ),
    );
  const resolveCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      urlOf(url).includes('/bank/resolve'),
    );
  const okResolve = () =>
    jsonResponse(200, {
      data: { account_name: 'ADA OKAFOR', account_number: '0123456789' },
    });

  it('serves a repeat resolve from the cache without calling Paystack again', async () => {
    const { resolve, redis } = setup();
    paystack(okResolve());

    const first = await resolve();
    const second = await resolve();

    expect(first.accountName).toBe('ADA OKAFOR');
    expect(second).toEqual(first);
    expect(resolveCalls()).toHaveLength(1);
    const keys = redis.set.mock.calls.map(([key]) => key);
    expect(keys.some((key) => key.includes('0123456789'))).toBe(false);
  });

  it('reports a Paystack 429 as unavailable, not as bad bank details', async () => {
    const { resolve } = setup();
    paystack(jsonResponse(429, { message: 'Rate limit exceeded' }));

    const error: unknown = await resolve().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).toBe(
      'Bank verification is busy right now. Try again in a few minutes.',
    );
  });

  it('reports the Paystack test-mode daily limit with its own message', async () => {
    const { resolve } = setup();
    paystack(
      jsonResponse(429, {
        status: false,
        message:
          'Test mode daily limit of 3 live bank resolves exceeded. Use test bank codes 001 or upgrade to live mode.',
        meta: { nextStep: 'Try again later' },
        type: 'api_error',
        code: 'unknown',
      }),
    );

    const error: unknown = await resolve().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).toBe(
      'Bank verification has reached its daily limit. Try again tomorrow.',
    );
  });

  it('reports a Paystack 422 as bad bank details', async () => {
    const { resolve } = setup();
    paystack(jsonResponse(422, { message: 'Could not resolve account name' }));

    await expect(resolve()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still resolves through Paystack when Redis get throws', async () => {
    const { resolve } = setup({ failGet: true });
    paystack(okResolve());

    await expect(resolve()).resolves.toMatchObject({
      accountName: 'ADA OKAFOR',
    });
  });
});
