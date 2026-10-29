import { quoteItemsTotal } from './quote-items';

describe('quoteItemsTotal', () => {
  it('sums quantity times unit price in kobo', () => {
    expect(
      quoteItemsTotal([
        { description: 'Pipe', quantity: 2, unitPrice: 5_000 },
        { description: 'Labour', quantity: 1, unitPrice: 20_000 },
      ]),
    ).toEqual({ ok: true, total: 30_000n });
  });

  it.each([
    ['no items', []],
    ['a non-array', undefined],
    ['a blank description', [{ description: ' ', quantity: 1, unitPrice: 1 }]],
    ['a zero quantity', [{ description: 'x', quantity: 0, unitPrice: 1 }]],
    [
      'a fractional quantity',
      [{ description: 'x', quantity: 1.5, unitPrice: 1 }],
    ],
    ['a negative price', [{ description: 'x', quantity: 1, unitPrice: -1 }]],
  ])('rejects %s with the line-item message', (_name, items) => {
    expect(quoteItemsTotal(items)).toMatchObject({
      ok: false,
      status: 422,
      message:
        'Add a description, positive quantity and unit price for every line item.',
    });
  });

  it('rejects a total beyond the safe integer range', () => {
    expect(
      quoteItemsTotal([
        {
          description: 'x',
          quantity: Number.MAX_SAFE_INTEGER,
          unitPrice: Number.MAX_SAFE_INTEGER,
        },
      ]),
    ).toMatchObject({ ok: false, message: 'The quote total is too large.' });
  });
});
