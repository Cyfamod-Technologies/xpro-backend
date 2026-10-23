import { FROZEN, formatRequestId, isOpen, parseRequestId, TERMINAL } from './statuses';

describe('request status helpers', () => {
  it('marks only closed, cancelled and rejected as terminal', () => {
    expect([...TERMINAL]).toEqual(['closed', 'cancelled', 'rejected']);
    expect(isOpen('acknowledged')).toBe(true);
    expect(isOpen('cancelling')).toBe(true);
    expect(isOpen('closed')).toBe(false);
  });

  it('marks acknowledged and cancelling as frozen', () => {
    expect([...FROZEN]).toEqual(['acknowledged', 'cancelling']);
  });

  it('formats and parses XPR request identifiers', () => {
    expect(formatRequestId(42)).toBe('XPR-00042');
    expect(parseRequestId('XPR-00042')).toBe(42);
    expect(formatRequestId(100_000)).toBe('XPR-100000');
    expect(parseRequestId('XPR-100000')).toBe(100_000);
    expect(parseRequestId('XPR-00000')).toBeNull();
    expect(parseRequestId('xpr-00042')).toBeNull();
  });

  it('rejects out-of-range sequences when formatting', () => {
    expect(() => formatRequestId(0)).toThrow(RangeError);
    expect(() => formatRequestId(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(parseRequestId('XPR-999999999999999999')).toBeNull();
  });
});
