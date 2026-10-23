import { AppError } from '../errors/app-error';
import { parseIdempotencyKey } from './idempotency-key.decorator';
import { hashRequest } from './idempotency.service';

describe('parseIdempotencyKey', () => {
  it('returns a valid key trimmed', () => {
    expect(parseIdempotencyKey(' abcdefgh ')).toBe('abcdefgh');
    expect(parseIdempotencyKey('x'.repeat(128))).toHaveLength(128);
  });

  it('returns undefined when absent and optional', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('throws 422 VALIDATION_ERROR with the spec message when required', () => {
    try {
      parseIdempotencyKey(undefined, { required: true });
      fail('expected throw');
    } catch (e) {
      expect((e as AppError).getStatus()).toBe(422);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
      expect((e as AppError).message).toBe(
        'Idempotency-Key header is required.',
      );
    }
  });

  it.each(['short', 'x'.repeat(129)])('rejects length %#', (value) => {
    expect(() => parseIdempotencyKey(value)).toThrow(AppError);
  });
});

describe('hashRequest', () => {
  it('ignores object key order and undefined fields', () => {
    expect(hashRequest('post', '/a', { a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequest('POST', '/a', { b: { d: 3, c: 2 }, a: 1, e: undefined }),
    );
  });

  it('differs on method, path or body', () => {
    const base = hashRequest('POST', '/a', { a: 1 });
    expect(hashRequest('PUT', '/a', { a: 1 })).not.toBe(base);
    expect(hashRequest('POST', '/b', { a: 1 })).not.toBe(base);
    expect(hashRequest('POST', '/a', { a: 2 })).not.toBe(base);
  });
});
