import type { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { SessionStore } from '../redis/session-store.service';
import { RedisAuthService } from './redis-auth.service';

describe('RedisAuthService email verification codes', () => {
  const values = new Map<string, string>();
  const redis = {
    setex: jest.fn((key: string, _ttl: number, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(
      (_script: string, _keyCount: number, key: string, expected: string) => {
        if (values.get(key) !== expected) return 0;
        values.delete(key);
        return 1;
      },
    ),
  };
  const service = new RedisAuthService(
    {} as JwtService,
    redis as unknown as Redis,
    {} as SessionStore,
  );

  beforeEach(() => {
    values.clear();
    jest.clearAllMocks();
  });

  it('scopes matching codes to each intended user', async () => {
    await service.storeEmailVerificationCode('user-1', 'same-hash');
    await service.storeEmailVerificationCode('user-2', 'same-hash');

    await expect(
      service.consumeEmailVerificationCode('user-1', 'same-hash'),
    ).resolves.toBe(true);
    await expect(
      service.consumeEmailVerificationCode('user-2', 'same-hash'),
    ).resolves.toBe(true);
  });

  it('does not consume the current code after a failed comparison', async () => {
    await service.storeEmailVerificationCode('user-1', 'current-hash');

    await expect(
      service.consumeEmailVerificationCode('user-1', 'wrong-hash'),
    ).resolves.toBe(false);
    await expect(
      service.consumeEmailVerificationCode('user-1', 'current-hash'),
    ).resolves.toBe(true);
  });

  it('replaces the previous code when a new one is stored', async () => {
    await service.storeEmailVerificationCode('user-1', 'old-hash');
    await service.storeEmailVerificationCode('user-1', 'new-hash');

    await expect(
      service.consumeEmailVerificationCode('user-1', 'old-hash'),
    ).resolves.toBe(false);
    await expect(
      service.consumeEmailVerificationCode('user-1', 'new-hash'),
    ).resolves.toBe(true);
  });
});
