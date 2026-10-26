import type { VerifiedTransaction } from '../payment-gateway';
import { compareTransaction, matches } from './transaction-match';

const payment = {
  id: 'pay-1',
  reference: 'xpro_abc',
  amount: 150_000_00n,
  requestId: 'req-1',
  quoteId: 'quote-1',
};
const verified = (overrides: Partial<VerifiedTransaction> = {}) =>
  ({
    status: 'success',
    reference: 'xpro_abc',
    amount: 150_000_00,
    currency: 'NGN',
    customer: { email: 'Owner@Example.com' },
    metadata: { paymentId: 'pay-1', requestId: 'req-1', quoteId: 'quote-1' },
    ...overrides,
  }) as VerifiedTransaction;

describe('compareTransaction', () => {
  it('matches a successful NGN transaction for the exact amount, owner and metadata', () => {
    expect(
      compareTransaction(verified(), payment, 'owner@example.com'),
    ).toEqual({
      matches: true,
    });
  });

  it('reads metadata sent as a JSON string', () => {
    expect(
      matches(
        verified({
          metadata: JSON.stringify({
            paymentId: 'pay-1',
            requestId: 'req-1',
            quoteId: 'quote-1',
          }),
        }),
        payment,
        'owner@example.com',
      ),
    ).toBe(true);
  });

  const cases: Array<[string, Partial<VerifiedTransaction>, string | null]> = [
    ['status', { status: 'abandoned' }, 'owner@example.com'],
    ['reference', { reference: 'xpro_other' }, 'owner@example.com'],
    ['amount (short)', { amount: 150_000_00 - 1 }, 'owner@example.com'],
    ['amount (over)', { amount: 150_000_00 + 1 }, 'owner@example.com'],
    ['currency', { currency: 'USD' }, 'owner@example.com'],
    [
      'customer email',
      { customer: { email: 'other@example.com' } },
      'owner@example.com',
    ],
    ['missing customer', { customer: undefined }, 'owner@example.com'],
    ['missing owner email', {}, null],
    [
      'payment id',
      { metadata: { paymentId: 'x', requestId: 'req-1', quoteId: 'quote-1' } },
      'owner@example.com',
    ],
    [
      'request id',
      { metadata: { paymentId: 'pay-1', requestId: 'x', quoteId: 'quote-1' } },
      'owner@example.com',
    ],
    [
      'quote id',
      { metadata: { paymentId: 'pay-1', requestId: 'req-1', quoteId: 'x' } },
      'owner@example.com',
    ],
    ['metadata absent', { metadata: undefined }, 'owner@example.com'],
    ['metadata malformed', { metadata: '{nope' }, 'owner@example.com'],
  ];

  it.each(cases)(
    'does not match when the %s differs',
    (_name, override, email) => {
      const result = compareTransaction(verified(override), payment, email);
      expect(result.matches).toBe(false);
      if (!result.matches) expect(result.reason).toMatch(/\.$/);
      expect(matches(verified(override), payment, email)).toBe(false);
    },
  );
});
