import { RequestSnapshotLoader, type RequestDb } from './snapshot.loader';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'customer-1';
const PROVIDER_USER_ID = 'provider-user-1';
const at = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`);

type QuoteRow = {
  id: string;
  version: number;
  status: string;
  acceptedAt?: Date | null;
};

const quote = (row: QuoteRow) => ({
  requestId: REQUEST_ID,
  approvalRequestedAt: null,
  validUntil: null,
  payoutAmount: null,
  payoutAssignmentId: null,
  basedOnAssignmentId: null,
  providerChangedAt: null,
  acceptedAt: null,
  ...row,
});

type Options = {
  quotes?: QuoteRow[];
  payments?: Array<{ status: string; createdAt: Date; quoteId: string }>;
  cancellations?: Array<Record<string, unknown>>;
  refundsOutstanding?: number;
  withAssignment?: boolean;
  userStatus?: string;
  verification?: string;
  reliabilityStatus?: string;
};

function build(options: Options = {}) {
  const row = {
    id: REQUEST_ID,
    number: 7,
    ownerId: OWNER_ID,
    staffOwnerId: null,
    status: 'awaiting_payment',
    intakeState: 'approved',
    contactInBrief: false,
    cityId: 'city-1',
    districtId: 'district-1',
    holdKind: null,
    defectsWindowEndsAt: null,
    reportApprovedAt: null,
    attachments: [],
    assignments: options.withAssignment
      ? [
          {
            id: 'assignment-1',
            providerUserId: PROVIDER_USER_ID,
            status: 'accepted',
            attempt: 1,
            expiresAt: at(30),
            createdAt: at(1),
          },
        ]
      : [],
    runs: [],
    contributions: [],
    quotes: (options.quotes ?? []).map(quote),
    schedules: [],
    updates: [],
    issues: [],
    cancellations: options.cancellations ?? [],
    noShows: [],
    messages: [],
  };
  const tx = {
    serviceRequest: { findUnique: jest.fn().mockResolvedValue(row) },
    providerProfile: {
      findUnique: jest.fn().mockResolvedValue({
        trade: 'Plumbing',
        verification: options.verification ?? 'approved',
        reliabilityStatus: options.reliabilityStatus ?? 'normal',
        user: { firstName: 'Pat', lastName: 'Provider' },
      }),
    },
    location: { findUnique: jest.fn().mockResolvedValue({ name: 'Lagos' }) },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          status:
            where.id === PROVIDER_USER_ID
              ? (options.userStatus ?? 'active')
              : 'active',
        }),
      ),
    },
    requestTimer: { findFirst: jest.fn().mockResolvedValue(null) },
    upload: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { findMany: jest.fn().mockResolvedValue(options.payments ?? []) },
    refund: {
      count: jest.fn().mockResolvedValue(options.refundsOutstanding ?? 0),
    },
    $queryRaw: jest.fn(),
  };
  return tx;
}

async function load(options: Options = {}) {
  const tx = build(options);
  const loaded = await new RequestSnapshotLoader().load(
    tx as unknown as RequestDb,
    REQUEST_ID,
  );
  return { tx, snapshot: loaded!.snapshot };
}

describe('RequestSnapshotLoader payment state', () => {
  const accepted = [
    { id: 'q2', version: 2, status: 'accepted' },
    { id: 'q1', version: 1, status: 'superseded' },
  ];

  it('selects only the columns it needs', async () => {
    const { tx } = await load();
    expect(tx.payment.findMany).toHaveBeenCalledWith({
      where: { requestId: REQUEST_ID },
      select: { status: true, createdAt: true, quoteId: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('is unpaid with no payments', async () => {
    const { snapshot } = await load({ quotes: accepted });
    expect(snapshot.payment).toEqual({
      paid: false,
      pendingPaymentAt: null,
      offlineRecorded: false,
    });
  });

  it.each(['paid', 'partially_refunded'])(
    'is paid when the accepted quote has a %s payment',
    async (status) => {
      const { snapshot } = await load({
        quotes: accepted,
        payments: [{ status, createdAt: at(5), quoteId: 'q2' }],
      });
      expect(snapshot.payment.paid).toBe(true);
    },
  );

  it.each(['pending', 'recorded', 'failed', 'refunded', 'reversed'])(
    'is not paid for a %s payment on the accepted quote',
    async (status) => {
      const { snapshot } = await load({
        quotes: accepted,
        payments: [{ status, createdAt: at(5), quoteId: 'q2' }],
      });
      expect(snapshot.payment.paid).toBe(false);
    },
  );

  it('ignores a paid payment that belongs to a superseded quote', async () => {
    const { snapshot } = await load({
      quotes: accepted,
      payments: [{ status: 'paid', createdAt: at(5), quoteId: 'q1' }],
    });
    expect(snapshot.payment.paid).toBe(false);
  });

  it('falls back to any settled payment when no quote is accepted', async () => {
    const { snapshot } = await load({
      quotes: [{ id: 'q1', version: 1, status: 'expired' }],
      payments: [{ status: 'paid', createdAt: at(5), quoteId: 'q1' }],
    });
    expect(snapshot.payment.paid).toBe(true);
  });

  it('reports the newest pending or recorded payment', async () => {
    const { snapshot } = await load({
      quotes: accepted,
      payments: [
        { status: 'failed', createdAt: at(9), quoteId: 'q2' },
        { status: 'recorded', createdAt: at(8), quoteId: 'q2' },
        { status: 'pending', createdAt: at(6), quoteId: 'q2' },
      ],
    });
    expect(snapshot.payment.pendingPaymentAt).toEqual(at(8));
  });

  it('flags a recorded offline payment, whatever other payments exist', async () => {
    const recorded = await load({
      quotes: accepted,
      payments: [
        { status: 'pending', createdAt: at(9), quoteId: 'q2' },
        { status: 'recorded', createdAt: at(4), quoteId: 'q2' },
      ],
    });
    expect(recorded.snapshot.payment.offlineRecorded).toBe(true);
    const pendingOnly = await load({
      quotes: accepted,
      payments: [{ status: 'pending', createdAt: at(9), quoteId: 'q2' }],
    });
    expect(pendingOnly.snapshot.payment.offlineRecorded).toBe(false);
    const settled = await load({
      quotes: accepted,
      payments: [{ status: 'paid', createdAt: at(9), quoteId: 'q2' }],
    });
    expect(settled.snapshot.payment.offlineRecorded).toBe(false);
  });
});

describe('RequestSnapshotLoader quotes', () => {
  it('latestSentQuote ignores a newer draft', async () => {
    const { snapshot } = await load({
      quotes: [
        { id: 'q2', version: 2, status: 'draft' },
        { id: 'q1', version: 1, status: 'sent' },
      ],
    });
    expect(snapshot.latestQuote?.version).toBe(2);
    expect(snapshot.latestSentQuote).toMatchObject({
      version: 1,
      status: 'sent',
    });
  });

  it('latestSentQuote is the highest sent version and null without one', async () => {
    const withSent = await load({
      quotes: [
        { id: 'q3', version: 3, status: 'sent' },
        { id: 'q2', version: 2, status: 'sent' },
      ],
    });
    expect(withSent.snapshot.latestSentQuote?.version).toBe(3);
    const withoutSent = await load({
      quotes: [{ id: 'q1', version: 1, status: 'draft' }],
    });
    expect(withoutSent.snapshot.latestSentQuote).toBeNull();
  });
});

describe('RequestSnapshotLoader provider standing', () => {
  it('is null without an assignment', async () => {
    const { snapshot } = await load();
    expect(snapshot.providerStanding).toBeNull();
  });

  it.each([
    [{}, 'active'],
    [{ userStatus: 'suspended' }, 'suspended'],
    [{ verification: 'delisted' }, 'delisted'],
    [{ reliabilityStatus: 'restricted' }, 'restricted'],
    [{ reliabilityStatus: 'under_review' }, 'active'],
  ] as Array<[Options, string]>)('maps %j to %s', async (options, expected) => {
    const { snapshot } = await load({ withAssignment: true, ...options });
    expect(snapshot.providerStanding).toBe(expected);
  });
});

describe('RequestSnapshotLoader cancellation and refunds', () => {
  it('exposes the pending cancellation row', async () => {
    const { snapshot } = await load({
      cancellations: [
        {
          id: 'c2',
          status: 'withdrawn',
          requestedBy: 'customer',
          paid: false,
          workStarted: false,
        },
        {
          id: 'c1',
          status: 'pending',
          requestedBy: 'staff',
          paid: true,
          workStarted: true,
        },
      ],
    });
    expect(snapshot.pendingCancellation).toBe(true);
    expect(snapshot.pendingCancellationInfo).toEqual({
      id: 'c1',
      status: 'pending',
      requestedBy: 'staff',
      paid: true,
      workStarted: true,
    });
  });

  it('has no pending cancellation when none is pending', async () => {
    const { snapshot } = await load({
      cancellations: [
        {
          id: 'c1',
          status: 'completed',
          requestedBy: 'customer',
          paid: true,
          workStarted: false,
        },
      ],
    });
    expect(snapshot.pendingCancellation).toBe(false);
    expect(snapshot.pendingCancellationInfo).toBeNull();
  });

  it('counts refunds that are not completed, waived or rejected', async () => {
    const { tx, snapshot } = await load({ refundsOutstanding: 2 });
    expect(snapshot.refundsOutstanding).toBe(2);
    expect(tx.refund.count).toHaveBeenCalledWith({
      where: {
        requestId: REQUEST_ID,
        status: { notIn: ['completed', 'waived', 'rejected'] },
      },
    });
  });
});
