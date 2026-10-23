import { AppError } from '../errors/app-error';
import { parseIfMatch } from './if-match.decorator';
import { formatEtag, parseEtag } from './etag.util';

describe('parseIfMatch', () => {
  it('parses weak and plain forms', () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch('"7"')).toBe(7);
    expect(parseIfMatch(' W/"0" ')).toBe(0);
  });

  it('returns undefined when absent and optional', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('')).toBeUndefined();
  });

  it('throws 422 VALIDATION_ERROR when absent and required', () => {
    try {
      parseIfMatch(undefined, { required: true });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).getStatus()).toBe(422);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
      expect((e as AppError).message).toBe(
        'Refresh the request and try again.',
      );
    }
  });

  it.each(['7', 'W/7', '"abc"', '*', 'W/"-1"', 'W/""'])(
    'rejects malformed value %s',
    (value) => {
      expect(() => parseIfMatch(value)).toThrow(AppError);
    },
  );

  it('round-trips the etag helpers', () => {
    expect(formatEtag(12)).toBe('W/"12"');
    expect(parseEtag(formatEtag(12))).toBe(12);
  });
});
