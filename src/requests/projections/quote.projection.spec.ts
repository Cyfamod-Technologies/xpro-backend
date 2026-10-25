import type { Contribution, Quote } from '@prisma/client';
import {
  customerCurrentQuote,
  customerQuoteView,
  payoutSuggestion,
  providerContributionView,
  providerCurrentQuote,
  providerQuoteView,
  staffContributionView,
  staffQuoteView,
} from './quote.projection';

const at = new Date('2026-10-24T10:00:00.000Z');

const quoteRow = (overrides: Partial<Quote> = {}): Quote => ({
  id: 'quote-1',
  requestId: 'request-1',
  version: 2,
  revision: 3,
  status: 'sent',
  items: [
    { description: 'Labour', quantity: 2, unitPrice: 250_000 },
    { description: 'Pipe', quantity: 4, unitPrice: '50000' },
  ],
  total: 700_000n,
  note: 'Excludes tiling',
  basedOnAssignmentId: 'assignment-1',
  pricingOverrideNote: 'No costing: urgent job',
  customerNote: 'Held customer note',
  lastEditedBy: 'staff-1',
  approvalRequestedBy: null,
  approvalRequestedAt: null,
  approvedBy: null,
  selfApproved: false,
  returnedNote: 'Check the labour rate',
  publishedBy: 'staff-2',
  publishedAt: at,
  validUntil: new Date('2026-11-07T10:00:00.000Z'),
  respondedAt: null,
  responseNote: null,
  acceptedAt: null,
  paymentDueAt: null,
  providerChangedAt: null,
  payoutAmount: 400_000n,
  payoutAssignmentId: 'assignment-1',
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const INTERNAL_KEYS = [
  'revision',
  'pricingOverrideNote',
  'lastEditedBy',
  'approvalRequestedBy',
  'approvalRequestedAt',
  'approvedBy',
  'selfApproved',
  'returnedNote',
  'publishedBy',
  'basedOnAssignmentId',
  'payoutAmount',
  'payoutAssignmentId',
  'payoutSuggestion',
  'blockedReason',
  'amountsHidden',
  'requestId',
  'providerChangedAt',
  'createdAt',
  'updatedAt',
];

describe('customerQuoteView (04 §4.6)', () => {
  it('returns exactly the published fields with money as numbers', () => {
    const view = customerQuoteView(quoteRow({ acceptedAt: at }));
    expect(view).toEqual({
      id: 'quote-1',
      version: 2,
      status: 'sent',
      items: [
        { description: 'Labour', quantity: 2, unitPrice: 250_000 },
        { description: 'Pipe', quantity: 4, unitPrice: 50_000 },
      ],
      total: 700_000,
      note: 'Excludes tiling',
      validUntil: new Date('2026-11-07T10:00:00.000Z'),
      publishedAt: at,
      acceptedAt: at,
      paymentDueAt: null,
    });
    for (const key of INTERNAL_KEYS) expect(view).not.toHaveProperty(key);
  });

  it('selects the highest sent or accepted version, never a draft', () => {
    const rows = [
      quoteRow({ id: 'q-4', version: 4, status: 'draft' }),
      quoteRow({ id: 'q-3', version: 3, status: 'sent' }),
      quoteRow({ id: 'q-2', version: 2, status: 'superseded' }),
    ];
    expect(customerCurrentQuote(rows)?.id).toBe('q-3');
    expect(
      customerCurrentQuote([quoteRow({ status: 'draft' })]),
    ).toBeUndefined();
  });
});

describe('providerQuoteView (04 §10, 05)', () => {
  it('returns scope lines only, with no rates, totals or notes', () => {
    const view = providerQuoteView(quoteRow({ payoutAssignmentId: null }), [
      'assignment-1',
    ]);
    expect(view).toEqual({
      id: 'quote-1',
      version: 2,
      status: 'sent',
      scope: [
        { description: 'Labour', quantity: 2 },
        { description: 'Pipe', quantity: 4 },
      ],
    });
    for (const key of [
      'items',
      'total',
      'note',
      'unitPrice',
      'payoutAmount',
      ...INTERNAL_KEYS.filter((key) => key !== 'payoutAmount'),
    ])
      expect(view).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toContain('unitPrice');
  });

  it('adds the payout only when it belongs to one of their assignments', () => {
    expect(providerQuoteView(quoteRow(), ['assignment-1'])).toMatchObject({
      payoutAmount: 400_000,
    });
    expect(providerQuoteView(quoteRow(), ['assignment-9'])).not.toHaveProperty(
      'payoutAmount',
    );
    expect(
      providerQuoteView(quoteRow({ payoutAmount: null }), ['assignment-1']),
    ).not.toHaveProperty('payoutAmount');
  });

  it('prefers the accepted quote over the sent one', () => {
    const rows = [
      quoteRow({ id: 'q-3', version: 3, status: 'sent' }),
      quoteRow({ id: 'q-2', version: 2, status: 'accepted' }),
    ];
    expect(providerCurrentQuote(rows)?.id).toBe('q-2');
  });
});

describe('staffQuoteView', () => {
  const viewer = {
    canSeePricing: true,
    userId: 'staff-9',
    canApprove: true,
    isSuperAdmin: false,
  };

  it('returns everything staff act on, including id, revision and dates', () => {
    const view = staffQuoteView(quoteRow(), {
      ...viewer,
      payoutSuggestion: 380_000,
    });
    expect(view).toMatchObject({
      id: 'quote-1',
      version: 2,
      revision: 3,
      status: 'sent',
      total: 700_000,
      payoutAmount: 400_000,
      payoutAssignmentId: 'assignment-1',
      payoutSuggestion: 380_000,
      pricingOverrideNote: 'No costing: urgent job',
      note: 'Excludes tiling',
      validUntil: new Date('2026-11-07T10:00:00.000Z'),
      paymentDueAt: null,
      amountsHidden: false,
      blockedReason: null,
    });
    expect(view.items).toEqual([
      { description: 'Labour', quantity: 2, unitPrice: 250_000 },
      { description: 'Pipe', quantity: 4, unitPrice: 50_000 },
    ]);
  });

  it('never exposes the customer note held for sign-off (B-15)', () => {
    for (const view of [
      customerQuoteView(quoteRow()),
      providerQuoteView(quoteRow(), ['assignment-1']),
      staffQuoteView(quoteRow(), { ...viewer, payoutSuggestion: null }),
    ])
      expect(JSON.stringify(view)).not.toContain('Held customer note');
  });

  it('masks amounts, notes and payout without view.pricing, leaving the keys absent', () => {
    const view = staffQuoteView(quoteRow(), {
      ...viewer,
      canSeePricing: false,
      payoutSuggestion: 380_000,
    });
    expect(view).toMatchObject({
      id: 'quote-1',
      revision: 3,
      total: null,
      payoutAmount: null,
      amountsHidden: true,
    });
    expect(view.items).toEqual([
      { description: 'Labour', quantity: 2 },
      { description: 'Pipe', quantity: 4 },
    ]);
    for (const key of [
      'note',
      'pricingOverrideNote',
      'payoutSuggestion',
      'payoutAssignmentId',
    ])
      expect(view).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toContain('250000');
    expect(JSON.stringify(view)).not.toContain('400000');
  });

  it('explains why the last editor cannot approve their own held draft', () => {
    const held = quoteRow({
      status: 'draft',
      approvalRequestedAt: at,
      lastEditedBy: 'staff-9',
    });
    expect(staffQuoteView(held, viewer).blockedReason).toBe(
      'You edited this quote last.',
    );
    expect(
      staffQuoteView(held, { ...viewer, userId: 'staff-3' }).blockedReason,
    ).toBeNull();
    expect(
      staffQuoteView(held, { ...viewer, canApprove: false }).blockedReason,
    ).toBeNull();
    expect(
      staffQuoteView(held, { ...viewer, isSuperAdmin: true }).blockedReason,
    ).toBeNull();
    expect(
      staffQuoteView(quoteRow({ lastEditedBy: 'staff-9' }), viewer)
        .blockedReason,
    ).toBeNull();
  });
});

describe('payoutSuggestion (04 §5.3 set_payout)', () => {
  const cost = (assignmentId: string, total: bigint) =>
    ({ assignmentId, total }) as Pick<Contribution, 'assignmentId' | 'total'>;

  it('is the latest costing total of the current assignment', () => {
    const rows = [
      cost('a-2', 320_000n),
      cost('a-2', 300_000n),
      cost('a-1', 1n),
    ];
    expect(payoutSuggestion(rows, 'a-2')).toBe(320_000);
  });

  it('is null without a current assignment or a costing for it', () => {
    expect(payoutSuggestion([cost('a-1', 1n)], 'a-2')).toBeNull();
    expect(payoutSuggestion([cost('a-1', 1n)], undefined)).toBeNull();
    expect(payoutSuggestion([], 'a-1')).toBeNull();
  });
});

describe('contribution views', () => {
  const row = {
    providerId: 'provider-1',
    total: 500_000n,
    items: [{ description: 'Labour', quantity: 2, unitPrice: '250000' }],
    note: 'costing note',
  };

  it('shows staff masked costing without view.pricing, not omitted', () => {
    const view = staffContributionView(row, false);
    expect(view).toEqual({
      providerId: 'provider-1',
      total: null,
      items: [{ description: 'Labour', quantity: 2 }],
      amountsHidden: true,
    });
    expect(view).not.toHaveProperty('note');
  });

  it('shows priced staff and the provider their own numbers', () => {
    expect(staffContributionView(row, true)).toMatchObject({
      total: 500_000,
      amountsHidden: false,
    });
    expect(providerContributionView(row)).toEqual({
      items: [{ description: 'Labour', quantity: 2, unitPrice: 250_000 }],
      note: 'costing note',
    });
  });
});
