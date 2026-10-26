import { amountDue } from './amount-due';

describe('amountDue', () => {
  it('is the whole total when nothing has settled', () => {
    expect(amountDue(500_000n, [])).toBe(500_000n);
    expect(
      amountDue(500_000n, [
        { amount: 500_000n, status: 'pending' },
        { amount: 500_000n, status: 'recorded' },
        { amount: 500_000n, status: 'failed' },
      ]),
    ).toBe(500_000n);
  });

  it('is zero once the total is paid', () => {
    expect(amountDue(500_000n, [{ amount: 500_000n, status: 'paid' }])).toBe(
      0n,
    );
  });

  it('subtracts only settled collections', () => {
    expect(
      amountDue(500_000n, [
        { amount: 200_000n, status: 'paid' },
        { amount: 100_000n, status: 'pending' },
      ]),
    ).toBe(300_000n);
  });

  it('counts refunded collections as net of completed refunds', () => {
    expect(
      amountDue(
        500_000n,
        [{ amount: 500_000n, status: 'partially_refunded' }],
        100_000n,
      ),
    ).toBe(100_000n);
    expect(
      amountDue(500_000n, [{ amount: 500_000n, status: 'refunded' }], 500_000n),
    ).toBe(500_000n);
  });

  it('never goes below zero', () => {
    expect(amountDue(100_000n, [{ amount: 300_000n, status: 'paid' }])).toBe(
      0n,
    );
  });
});
