import { PRICING_GUARDS } from './pricing-guards';
import {
  assignment,
  check,
  customer,
  failure,
  HOUR,
  NOW,
  provider,
  quote,
  snapshot,
  staff,
} from './guard.testkit';
import type { RequestSnapshot } from './snapshot';

const run = (
  key: string,
  snap: RequestSnapshot,
  actor = staff('quote.manage'),
  input?: unknown,
) => check(PRICING_GUARDS, key, snap, actor, input);

const items = [{ description: 'Pipe', quantity: 2, unitPrice: 5_000 }];
const matched = (overrides: Partial<RequestSnapshot> = {}) =>
  snapshot({
    status: 'matched',
    intake: { state: 'approved' },
    currentProviderUserId: 'provider-1',
    providerStanding: 'active',
    currentAssignment: assignment('accepted'),
    providerCostingSubmitted: true,
    ...overrides,
  });
const PAID = failure(
  409,
  'STATE_CONFLICT',
  'This job is paid. Change the price through a variation.',
);

describe('quote.contribute (04 §6.10)', () => {
  const contribute = (snap = matched(), actor = provider(), input?: unknown) =>
    run('quote.contribute', snap, actor, input);

  it('passes for the accepted provider while the job is not started', () => {
    for (const status of [
      'matched',
      'quoted',
      'awaiting_payment',
      'scheduled',
    ] as const)
      expect(contribute(matched({ status }))).toEqual({ ok: true });
  });

  it('allows ready_to_schedule only after a replacement (B-40)', () => {
    const acceptedQuote = (providerChangedAt: Date | null) => {
      const accepted = quote('accepted', { providerChangedAt });
      return matched({
        status: 'ready_to_schedule',
        latestQuote: accepted,
        quotes: [accepted],
      });
    };
    expect(contribute(acceptedQuote(NOW))).toEqual({ ok: true });
    expect(contribute(acceptedQuote(null))).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        "Costing can't change once work has started.",
      ),
    );
    expect(contribute(matched({ status: 'ready_to_schedule' }))).toMatchObject({
      status: 409,
    });
  });

  it('refuses statuses outside the allow-list (B-40)', () => {
    for (const status of [
      'cancelling',
      'cancelled',
      'rejected',
      'closed',
    ] as const)
      expect(contribute(matched({ status }))).toMatchObject({
        status: 409,
        message: 'This request is no longer open.',
      });
    for (const status of ['submitted', 'under_review', 'acknowledged'] as const)
      expect(contribute(matched({ status }))).toMatchObject({
        message: "Costing can't change once work has started.",
      });
  });

  it('is only for the current provider', () => {
    expect(contribute(matched(), provider('provider-2'))).toMatchObject({
      status: 403,
    });
    expect(contribute(matched(), customer() as never)).toMatchObject({
      status: 403,
    });
  });

  it('needs an accepted assignment', () => {
    expect(
      contribute(matched({ currentAssignment: assignment('offered') })),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Accept the current assignment before updating this job.',
      ),
    );
  });

  it("refuses once work has started with the spec's message", () => {
    for (const status of [
      'in_progress',
      'blocked',
      'completion_pending',
    ] as const)
      expect(contribute(matched({ status }))).toEqual(
        failure(
          409,
          'STATE_CONFLICT',
          "Costing can't change once work has started.",
        ),
      );
  });

  it('validates the line items when the body is given', () => {
    const lines = failure(
      422,
      'VALIDATION_ERROR',
      'Add a description, positive quantity and unit price for every line item.',
    );
    expect(contribute(matched(), provider(), { items: [] })).toEqual(lines);
    expect(
      contribute(matched(), provider(), {
        items: [{ description: ' ', quantity: 1, unitPrice: 1 }],
      }),
    ).toEqual(lines);
    expect(
      contribute(matched(), provider(), {
        items: [{ description: 'Pipe', quantity: 0, unitPrice: 1 }],
      }),
    ).toEqual(lines);
    expect(
      contribute(matched(), provider(), {
        items: [
          {
            description: 'Gold',
            quantity: Number.MAX_SAFE_INTEGER,
            unitPrice: 2,
          },
        ],
      }),
    ).toEqual(
      failure(422, 'VALIDATION_ERROR', 'The quote total is too large.'),
    );
    expect(contribute(matched(), provider(), { items })).toEqual({ ok: true });
  });

  it('is refused on a cancelling request', () => {
    expect(contribute(matched({ status: 'cancelling' }))).toMatchObject({
      message: 'This request is no longer open.',
    });
  });
});

describe('quote.save (04 §6.11 save table)', () => {
  it('passes for Pricing while a provider is confirmed', () => {
    for (const status of ['matched', 'quoted', 'awaiting_payment'] as const)
      expect(run('quote.save', matched({ status }))).toEqual({ ok: true });
  });

  it('needs quote.manage', () => {
    expect(run('quote.save', matched(), staff('quote.approve'))).toMatchObject({
      status: 403,
      message: 'Your staff role does not allow this action.',
    });
  });

  it('row 1: request paid', () => {
    expect(
      run(
        'quote.save',
        matched({
          payment: {
            paid: true,
            pendingPaymentAt: null,
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(PAID);
  });

  it('row 2: status matched, quoted or awaiting_payment', () => {
    expect(run('quote.save', matched({ status: 'under_review' }))).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Quotes can only be prepared once a provider is confirmed.',
      ),
    );
    expect(
      run('quote.save', matched({ status: 'ready_to_schedule' })),
    ).toMatchObject({ status: 409 });
  });

  it('needs a confirmed provider', () => {
    expect(
      run('quote.save', matched({ currentAssignment: null })),
    ).toMatchObject({
      message: 'Confirm a provider assignment before preparing a quote.',
    });
  });

  it('row 6: line items when the body is given', () => {
    expect(
      run('quote.save', matched(), staff('quote.manage'), { items: [] }),
    ).toMatchObject({ status: 422 });
    expect(
      run('quote.save', matched(), staff('quote.manage'), { items }),
    ).toEqual({ ok: true });
  });

  it('reports the paid row before the status row', () => {
    expect(
      run(
        'quote.save',
        matched({
          status: 'ready_to_schedule',
          payment: {
            paid: true,
            pendingPaymentAt: null,
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(PAID);
  });
});

describe('quote.publish (04 §6.11 publish table)', () => {
  const body = { revision: 1, pricingOverrideNote: undefined };

  it('passes with the provider costing in, no payment and a confirmed provider', () => {
    expect(run('quote.publish', matched())).toEqual({ ok: true });
    expect(
      run('quote.publish', matched(), staff('quote.manage'), body),
    ).toEqual({ ok: true });
  });

  it('row 3: current assignment accepted', () => {
    expect(run('quote.publish', matched({ currentAssignment: null }))).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Confirm a provider assignment before publishing the quote.',
      ),
    );
  });

  it('row 4: request paid', () => {
    expect(
      run(
        'quote.publish',
        matched({
          payment: {
            paid: true,
            pendingPaymentAt: null,
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(PAID);
  });

  it('row 5: a payment younger than 30 minutes is in progress', () => {
    const recent = new Date(NOW.getTime() - 10 * 60_000);
    expect(
      run(
        'quote.publish',
        matched({
          payment: {
            paid: false,
            pendingPaymentAt: recent,
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual(
      failure(
        409,
        'PAYMENT_IN_PROGRESS',
        'A payment is in progress for the current quote. Try again once it settles.',
      ),
    );
    expect(
      run(
        'quote.publish',
        matched({
          payment: {
            paid: false,
            pendingPaymentAt: new Date(NOW.getTime() - HOUR),
            offlineRecorded: false,
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('row 6: provider costing or an override note', () => {
    const noCosting = matched({ providerCostingSubmitted: false });
    expect(run('quote.publish', noCosting)).toEqual({ ok: true });
    expect(
      run('quote.publish', noCosting, staff('quote.manage'), body),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        "Get the provider's costing first, or add a pricing override note.",
      ),
    );
    expect(
      run('quote.publish', noCosting, staff('quote.manage'), {
        ...body,
        pricingOverrideNote: 'Costing agreed by phone.',
      }),
    ).toEqual({ ok: true });
  });

  it('row 8: replacing an accepted quote needs a customer note', () => {
    const replacing = matched({ status: 'awaiting_payment' });
    expect(run('quote.publish', replacing)).toEqual({ ok: true });
    expect(
      run('quote.publish', replacing, staff('quote.manage'), body),
    ).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Add a note for the customer explaining the new version.',
      ),
    );
    expect(
      run('quote.publish', replacing, staff('quote.manage'), {
        ...body,
        customerNote: 'The price now includes the new fittings.',
      }),
    ).toEqual({ ok: true });
  });

  it('needs quote.manage', () => {
    expect(run('quote.publish', matched(), staff())).toMatchObject({
      status: 403,
    });
  });
});

describe('quote.approve (04 §6.11 sign-off table)', () => {
  const awaitingApproval = (overrides: Partial<RequestSnapshot> = {}) =>
    matched({
      latestQuote: quote('draft', { approvalRequestedAt: NOW }),
      quotes: [quote('draft', { approvalRequestedAt: NOW })],
      ...overrides,
    });
  const approver = staff('quote.approve');

  it('passes for an approver on a draft awaiting approval', () => {
    expect(run('quote.approve', awaitingApproval(), approver)).toEqual({
      ok: true,
    });
  });

  it('row 1: draft awaiting approval', () => {
    const expected = failure(
      409,
      'STATE_CONFLICT',
      'This quote is not awaiting approval.',
    );
    expect(run('quote.approve', matched(), approver)).toEqual(expected);
    expect(
      run('quote.approve', matched({ latestQuote: quote('draft') }), approver),
    ).toEqual(expected);
    expect(
      run(
        'quote.approve',
        matched({
          latestQuote: quote('sent', { approvalRequestedAt: NOW }),
        }),
        approver,
      ),
    ).toEqual(expected);
  });

  it('row 4: the publish checks apply with the same messages', () => {
    expect(
      run(
        'quote.approve',
        awaitingApproval({ currentAssignment: null }),
        approver,
      ),
    ).toMatchObject({
      message: 'Confirm a provider assignment before publishing the quote.',
    });
    expect(
      run(
        'quote.approve',
        awaitingApproval({
          payment: {
            paid: true,
            pendingPaymentAt: null,
            offlineRecorded: false,
          },
        }),
        approver,
      ),
    ).toEqual(PAID);
  });

  it('needs quote.approve', () => {
    expect(
      run('quote.approve', awaitingApproval(), staff('quote.manage')),
    ).toMatchObject({ status: 403 });
  });
});

describe('quote.return (04 §6.11)', () => {
  const awaitingApproval = matched({
    latestQuote: quote('draft', { approvalRequestedAt: NOW }),
  });
  const approver = staff('quote.approve');

  it('passes for an approver on a draft awaiting approval', () => {
    expect(run('quote.return', awaitingApproval, approver)).toEqual({
      ok: true,
    });
  });

  it('refuses a quote that is not awaiting approval', () => {
    expect(run('quote.return', matched(), approver)).toEqual(
      failure(409, 'STATE_CONFLICT', 'This quote is not awaiting approval.'),
    );
  });

  it('needs a note when the body is given', () => {
    expect(
      run('quote.return', awaitingApproval, approver, { note: '  ' }),
    ).toEqual(
      failure(422, 'VALIDATION_ERROR', 'Add a note explaining what to change.'),
    );
    expect(
      run('quote.return', awaitingApproval, approver, {
        note: 'Check the labour hours.',
      }),
    ).toEqual({ ok: true });
  });

  it('needs quote.approve', () => {
    expect(
      run('quote.return', awaitingApproval, staff('quote.manage')),
    ).toMatchObject({ status: 403 });
  });
});

describe('quote.respond (04 §6.11 customer decision)', () => {
  const sentQuote = quote('sent', {
    validUntil: new Date(NOW.getTime() + 24 * HOUR),
  });
  const withCustomer = (overrides: Partial<RequestSnapshot> = {}) =>
    matched({
      status: 'quoted',
      latestQuote: sentQuote,
      latestSentQuote: sentQuote,
      quotes: [sentQuote],
      ...overrides,
    });
  const respond = (
    snap = withCustomer(),
    actor = customer(),
    input?: unknown,
  ) => run('quote.respond', snap, actor, input);

  it('passes for the owner on a sent, unexpired quote', () => {
    expect(respond()).toEqual({ ok: true });
    expect(
      respond(withCustomer(), customer(), { decision: 'accepted' }),
    ).toEqual({ ok: true });
  });

  it('is only for the owner', () => {
    expect(respond(withCustomer(), customer('customer-2'))).toMatchObject({
      status: 403,
    });
    expect(
      respond(withCustomer(), staff('quote.manage') as never),
    ).toMatchObject({ status: 403 });
  });

  it('lets a staff member who also holds the customer role answer their own quote', () => {
    const dualRole = {
      ...staff('quote.manage'),
      userId: 'customer-1',
      platformRoles: ['staff', 'customer'],
    };
    expect(respond(withCustomer(), dualRole)).toEqual({ ok: true });
    expect(
      respond(withCustomer(), { ...dualRole, userId: 'someone-else' }),
    ).toMatchObject({ status: 403 });
  });

  it('row 1: decision is one of the three', () => {
    expect(respond(withCustomer(), customer(), { decision: 'maybe' })).toEqual(
      failure(
        422,
        'VALIDATION_ERROR',
        'Choose accept, decline or request a revision.',
      ),
    );
  });

  it('row 2: the quote is the latest sent one', () => {
    const expected = failure(
      409,
      'STATE_CONFLICT',
      'This quote has already changed or received a response.',
    );
    expect(
      respond(
        withCustomer({ latestSentQuote: null, status: 'matched' }),
        customer(),
      ),
    ).toEqual(expected);
    expect(respond(withCustomer({ latestSentQuote: null }))).toEqual(expected);
  });

  it('row 3: now is before validUntil', () => {
    const expired = quote('sent', { validUntil: new Date(NOW.getTime() - 1) });
    expect(
      respond(withCustomer({ latestSentQuote: expired, latestQuote: expired })),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'This quote has expired. XPro will send you a new one.',
      ),
    );
  });

  it('row 4: a revision or decline needs a note', () => {
    const expected = failure(
      422,
      'VALIDATION_ERROR',
      'Explain the decline or revision request.',
    );
    expect(
      respond(withCustomer(), customer(), { decision: 'declined' }),
    ).toEqual(expected);
    expect(
      respond(withCustomer(), customer(), {
        decision: 'revision_requested',
        note: ' ',
      }),
    ).toEqual(expected);
    expect(
      respond(withCustomer(), customer(), {
        decision: 'revision_requested',
        note: 'Please lower the labour cost.',
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a decline while a cancellation is already pending (B-21)', () => {
    const pending = withCustomer({ pendingCancellation: true });
    expect(
      respond(pending, customer(), { decision: 'declined', note: 'Too dear.' }),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Your cancellation request is already awaiting XPro.',
      ),
    );
    expect(
      respond(pending, customer(), {
        decision: 'revision_requested',
        note: 'Lower it.',
      }),
    ).toEqual({ ok: true });
  });
});

describe('quote.setPayout (04 §2.1, §5.3 set_payout)', () => {
  const pricing = staff('quote.manage', 'view.pricing');
  const withSent = (overrides: Partial<RequestSnapshot> = {}) =>
    matched({
      status: 'quoted',
      quotes: [quote('sent')],
      latestQuote: quote('sent'),
      latestSentQuote: quote('sent'),
      ...overrides,
    });

  it('needs quote.manage and view.pricing', () => {
    expect(run('quote.setPayout', withSent(), pricing)).toEqual({ ok: true });
    expect(
      run('quote.setPayout', withSent(), staff('quote.manage')),
    ).toMatchObject({ status: 403 });
    expect(
      run('quote.setPayout', withSent(), staff('view.pricing')),
    ).toMatchObject({ status: 403 });
  });

  it('works on a sent or accepted quote only (B-42)', () => {
    const gone = failure(
      409,
      'STATE_CONFLICT',
      'This quote version no longer exists.',
    );
    for (const status of ['draft', 'expired', 'superseded'] as const)
      expect(
        run('quote.setPayout', matched({ quotes: [quote(status)] }), pricing),
      ).toEqual(gone);
    expect(
      run('quote.setPayout', matched({ quotes: [quote('accepted')] }), pricing),
    ).toEqual({ ok: true });
  });

  it('needs a current accepted assignment (B-42)', () => {
    expect(
      run(
        'quote.setPayout',
        withSent({ currentAssignment: assignment('offered') }),
        pricing,
      ),
    ).toEqual(
      failure(
        409,
        'STATE_CONFLICT',
        'Confirm a provider assignment before setting the payout.',
      ),
    );
    expect(
      run('quote.setPayout', withSent({ currentAssignment: null }), pricing),
    ).toMatchObject({ status: 409 });
  });

  it('needs a positive whole amount when the body is given', () => {
    const expected = failure(
      422,
      'VALIDATION_ERROR',
      'Enter a payout amount above 0 and no higher than the quote total.',
    );
    for (const amount of [0, -5, 10.5, '100', undefined])
      expect(run('quote.setPayout', withSent(), pricing, { amount })).toEqual(
        expected,
      );
    expect(
      run('quote.setPayout', withSent(), pricing, { amount: 90_000 }),
    ).toEqual({ ok: true });
  });

  it('is refused on a closed request', () => {
    expect(
      run('quote.setPayout', { ...withSent(), status: 'closed' }, pricing),
    ).toMatchObject({ message: 'This request is no longer open.' });
  });
});
