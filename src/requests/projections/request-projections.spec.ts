import { customerProjection } from './customer.projection';
import { providerProjection } from './provider.projection';
import { staffProjection } from './staff.projection';
import { listProjection } from './list.projection';
import type { ActorContext } from '../../platform/actor/actor.types';
import type { StaffPermission } from '../../staff/staff-permissions';
import type { RequestSnapshot } from '../domain/snapshot';
import type { LoadedRequest } from '../snapshot.loader';
import type { ProjectionContext } from './projection.helpers';

const now = new Date('2026-10-23T10:00:00.000Z');
const actor = (
  kind: ActorContext['kind'],
  permissions: StaffPermission[] = [],
): ActorContext => ({
  userId: 'user-1',
  kind,
  displayName: 'Test user',
  platformRoles: [
    kind === 'provider' ? 'provider' : kind === 'staff' ? 'staff' : 'customer',
  ],
  accountActive: true,
  ...(kind === 'staff'
    ? {
        staff: {
          status: 'active',
          roles: [],
          permissions: new Set(permissions),
          canOwn: true,
          isSuperAdmin: false,
          permVersion: 1,
        },
      }
    : {}),
});

function context(
  role: 'customer' | 'provider' | 'staff',
  rowOverrides: Partial<LoadedRequest> = {},
  snapshotOverrides: Partial<RequestSnapshot> = {},
  permissions: StaffPermission[] = [],
): ProjectionContext {
  const row = {
    id: 'request-uuid',
    number: 42,
    ownerId: 'customer-1',
    title: 'Kitchen renovation',
    service: 'Construction',
    cityId: 'city-1',
    districtId: 'district-1',
    address: 'Sensitive site address',
    phone: '+2348000000000',
    contactMethod: 'phone',
    description: 'Detailed customer brief that contains the work requested.',
    budget: 500000n,
    startDate: '2026-10-30',
    details: { workType: 'Renovation', access: 'gate code' },
    status: 'submitted',
    version: 4,
    contactInBrief: false,
    possibleDuplicateOf: null,
    intakeState: 'pending',
    clarificationAskedAt: null,
    clarificationCount: 0,
    intakeApprovedBy: null,
    intakeApprovedAt: null,
    offerBrief: 'Renovation request for a home.',
    shareOnConfirm: {},
    staffOwnerId: null,
    claimedAt: null,
    unclaimedSince: null,
    ownershipVersion: 1,
    dispatchMode: 'auto',
    autoAttempts: 0,
    needsAssignmentReason: null,
    lastRunId: null,
    holdKind: null,
    holdBy: null,
    holdReason: null,
    holdAt: null,
    holdPreviousStatus: null,
    issueCycles: 0,
    reportApprovedAt: null,
    confirmDueAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgedNote: null,
    defectsWindowEndsAt: null,
    cancellationId: null,
    closedAt: null,
    closedBy: null,
    createdAt: now,
    updatedAt: now,
    attachments: [],
    assignments: [],
    runs: [],
    contributions: [],
    quotes: [],
    schedules: [],
    updates: [],
    issues: [],
    cancellations: [],
    noShows: [],
    messages: [],
    ...rowOverrides,
  } as unknown as LoadedRequest;
  const snapshot: RequestSnapshot = {
    id: row.id,
    number: 'XPR-00042',
    ownerId: 'customer-1',
    status: 'submitted',
    intake: { state: 'pending' },
    currentAssignment: null,
    assignments: [],
    latestQuote: null,
    latestSentQuote: null,
    quotes: [],
    currentSchedule: null,
    replacedSchedule: null,
    pendingUpdates: [],
    openIssues: [],
    pendingCancellation: false,
    pendingCancellationInfo: null,
    refundsOutstanding: 0,
    latestNoShow: null,
    payment: { paid: false, pendingPaymentAt: null, offlineRecorded: false },
    payout: null,
    customerStanding: 'active',
    providerStanding: null,
    cascadePending: false,
    autoAttempts: 0,
    ...snapshotOverrides,
  };
  return {
    row,
    snapshot,
    actor: actor(role, permissions),
    role,
    now,
    settings: {},
  };
}

describe('request role projections', () => {
  it('includes stage actions and overlays in list summaries without exposing an offered provider title', () => {
    const provider = context('provider', {}, { status: 'under_review' });
    const summary = listProjection(
      provider.row,
      provider.snapshot,
      provider.actor,
      now,
      {},
    );
    expect(summary).toHaveProperty('allowedActions');
    expect(summary).toHaveProperty('overlays');
    expect(summary).not.toHaveProperty('title');
  });

  it('omits staff-only fields from the customer response', () => {
    const dto = customerProjection(context('customer'));
    expect(dto).not.toHaveProperty('contributions');
    expect(dto).not.toHaveProperty('dispatch');
    expect(dto).not.toHaveProperty('staffOwnerId');
  });

  it('gives staff the no-show row version the decision commands need (E-08)', () => {
    const row = {
      id: 'ns1',
      scheduleId: 's1',
      status: 'open',
      note: 'Nobody came.',
      detectedAt: now,
      version: 4,
    };
    const dto = staffProjection(
      context('staff', { noShows: [row] as never }, {}, ['dispatch.manage']),
    );
    expect(dto.noShows).toEqual([
      {
        id: 'ns1',
        scheduleId: 's1',
        status: 'open',
        version: 4,
        note: 'Nobody came.',
        createdAt: now,
      },
    ]);
  });

  it('keeps an offered provider response to the offer summary', () => {
    const assigned = {
      id: 'assignment-1',
      providerId: 'provider-1',
      providerUserId: 'user-1',
      status: 'offered',
      source: 'auto',
      attempt: 1,
      rankingRunId: null,
      score: {},
      overrideNote: null,
      overriddenRules: [],
      note: 'Dispatch note',
      offeredAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      response: null,
      crewConfirmed: null,
      respondedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      sharedDetails: null,
      endedAt: null,
      endedBy: null,
      workStarted: false,
      createdAt: now,
    };
    const dto = providerProjection(
      context(
        'provider',
        { assignments: [assigned] as never },
        {
          accessibleProviderUserIds: ['user-1'],
          currentProviderUserId: 'user-1',
          currentAssignment: {
            status: 'offered',
            attempt: 1,
            expiresAt: assigned.expiresAt,
          },
          assignments: [
            { status: 'offered', attempt: 1, expiresAt: assigned.expiresAt },
          ],
        },
      ),
    );
    expect(dto.assignment).toMatchObject({
      status: 'offered',
      offerBrief: 'Renovation request for a home.',
    });
    expect(dto).not.toHaveProperty('phone');
    expect(dto).not.toHaveProperty('budget');
    expect(dto).not.toHaveProperty('customerName');
    expect(dto).not.toHaveProperty('address');
    expect(dto.details).toEqual({ workType: 'Renovation' });
    expect(dto).not.toHaveProperty('description');
  });

  it('masks quote money from staff without view.pricing', () => {
    const quote = {
      id: 'quote-1',
      requestId: 'request-uuid',
      version: 1,
      revision: 1,
      status: 'sent',
      items: [{ description: 'Labour', quantity: 1, unitPrice: 500000 }],
      total: 500000n,
      note: 'internal pricing note',
      basedOnAssignmentId: null,
      pricingOverrideNote: null,
      lastEditedBy: 'staff-1',
      approvalRequestedBy: null,
      approvalRequestedAt: null,
      approvedBy: null,
      selfApproved: false,
      returnedNote: null,
      publishedBy: 'staff-1',
      publishedAt: now,
      validUntil: null,
      respondedAt: null,
      responseNote: null,
      acceptedAt: null,
      paymentDueAt: null,
      providerChangedAt: null,
      payoutAmount: 300000n,
      payoutAssignmentId: null,
      createdAt: now,
      updatedAt: now,
    };
    const dto = staffProjection(
      context('staff', { quotes: [quote] as never }, {}, []),
    );
    expect(dto.quote).toMatchObject({
      total: null,
      payoutAmount: null,
      amountsHidden: true,
    });
    expect(dto.quote).toHaveProperty('items', [
      { description: 'Labour', quantity: 1 },
    ]);
    expect(dto.contributions).toEqual([]);
    expect(dto).not.toHaveProperty('phone');
    expect(dto.budget).toBeNull();
    expect(dto.details).not.toHaveProperty('access');
    expect(dto).toHaveProperty('ownerId', 'customer-1');
  });
  describe('FX-3.1 projection rules', () => {
    const baseAssignment = {
      id: 'assignment-1',
      providerId: 'provider-1',
      providerUserId: 'user-1',
      source: 'auto',
      attempt: 1,
      score: {},
      note: 'Dispatch note',
      offeredAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      sharedDetails: { fields: ['access'], description: true },
    };
    const quoteRow = (overrides: object = {}) =>
      ({
        version: 1,
        status: 'sent',
        items: [{ description: 'Labour', quantity: 2, unitPrice: '250000' }],
        total: 500000n,
        note: 'internal',
        payoutAmount: null,
        payoutAssignmentId: null,
        validUntil: null,
        paymentDueAt: null,
        ...overrides,
      }) as never;

    it('keeps contactInBrief to the staff projection (A-22)', () => {
      const snapshot = { contactInBrief: true };
      expect(
        customerProjection(context('customer', {}, snapshot)),
      ).not.toHaveProperty('contactInBrief');
      expect(staffProjection(context('staff', {}, snapshot))).toHaveProperty(
        'contactInBrief',
        true,
      );
      const provider = context(
        'provider',
        { assignments: [{ ...baseAssignment, status: 'offered' }] as never },
        { ...snapshot, accessibleProviderUserIds: ['user-1'] },
      );
      expect(providerProjection(provider)).not.toHaveProperty('contactInBrief');
      expect(
        providerProjection(context('provider', {}, snapshot)),
      ).not.toHaveProperty('contactInBrief');
    });

    it('shows customers and providers only their own side as next actor (A-22)', () => {
      expect(staffProjection(context('staff')).nextActor).toBe(
        'staff:request.review',
      );
      expect(customerProjection(context('customer')).nextActor).toBe('xpro');
      const awaitingCustomer = { intake: { state: 'clarification' as const } };
      expect(
        customerProjection(context('customer', {}, awaitingCustomer)).nextActor,
      ).toBe('customer');
      expect(
        staffProjection(context('staff', {}, awaitingCustomer)).nextActor,
      ).toBe('customer');
      expect(
        providerProjection(context('provider', {}, awaitingCustomer)).nextActor,
      ).toBe('xpro');
      const closed = { status: 'closed' as const };
      expect(
        customerProjection(context('customer', { status: 'closed' }, closed))
          .nextActor,
      ).toBe('none');
    });

    it('gives a pre-lock provider the offer details plus the shared fields, and keeps the brief and note (A-17)', () => {
      const dto = providerProjection(
        context(
          'provider',
          {
            assignments: [{ ...baseAssignment, status: 'accepted' }] as never,
          },
          {
            status: 'matched',
            accessibleProviderUserIds: ['user-1'],
            currentProviderUserId: 'user-1',
          },
        ),
      );
      expect(dto.details).toEqual({
        workType: 'Renovation',
        access: 'gate code',
      });
      expect(dto.assignment).toEqual({
        id: 'assignment-1',
        status: 'accepted',
        note: 'Dispatch note',
        offerBrief: 'Renovation request for a home.',
      });
    });

    it('returns quote item money as numbers to every role (A-23)', () => {
      const rows = { quotes: [quoteRow()] };
      const expected = [
        { description: 'Labour', quantity: 2, unitPrice: 250000 },
      ];
      expect(
        (
          customerProjection(context('customer', rows)).quote as {
            items: unknown;
          }
        ).items,
      ).toEqual(expected);
      expect(
        (
          staffProjection(context('staff', rows, {}, ['view.pricing']))
            .quote as { items: unknown }
        ).items,
      ).toEqual(expected);
      const contribution = {
        providerId: 'provider-1',
        assignmentId: 'assignment-1',
        total: 500000n,
        items: [{ description: 'Labour', quantity: 2, unitPrice: '250000' }],
        note: 'costing',
      };
      const own = providerProjection(
        context(
          'provider',
          {
            assignments: [{ ...baseAssignment, status: 'accepted' }] as never,
            contributions: [contribution] as never,
          },
          { accessibleProviderUserIds: ['user-1'] },
        ),
      );
      expect(own.contributions).toEqual([{ items: expected, note: 'costing' }]);
    });

    it('returns staff contributions without view.pricing masked, not omitted (A-23)', () => {
      const contribution = {
        providerId: 'provider-1',
        assignmentId: 'assignment-1',
        total: 500000n,
        items: [{ description: 'Labour', quantity: 2, unitPrice: 250000 }],
        note: 'costing note with rates',
      };
      const masked = staffProjection(
        context('staff', { contributions: [contribution] as never }),
      );
      expect(masked.contributions).toEqual([
        {
          providerId: 'provider-1',
          total: null,
          items: [{ description: 'Labour', quantity: 2 }],
          amountsHidden: true,
        },
      ]);
      const priced = staffProjection(
        context('staff', { contributions: [contribution] as never }, {}, [
          'view.pricing',
        ]),
      );
      expect(priced.contributions).toEqual([
        {
          providerId: 'provider-1',
          total: 500000,
          items: [{ description: 'Labour', quantity: 2, unitPrice: 250000 }],
          note: 'costing note with rates',
          amountsHidden: false,
        },
      ]);
    });

    it('fills quote labels with the quote version, not the assignment attempt (A-27)', () => {
      const currentAssignment = {
        status: 'accepted' as const,
        attempt: 2,
        expiresAt: now,
      };
      const revision = staffProjection(
        context(
          'staff',
          { status: 'matched' },
          {
            status: 'matched',
            currentAssignment,
            latestQuote: {
              status: 'revision_requested',
              version: 3,
              approvalRequestedAt: null,
              validUntil: null,
              payoutAmount: null,
            },
          },
        ),
      );
      expect(revision.statusLabel).toBe('Revise quote v3');
      const sent = staffProjection(
        context(
          'staff',
          { status: 'quoted' },
          {
            status: 'quoted',
            currentAssignment,
            latestQuote: {
              status: 'sent',
              version: 4,
              approvalRequestedAt: null,
              validUntil: null,
              payoutAmount: null,
            },
            latestSentQuote: {
              status: 'sent',
              version: 4,
              approvalRequestedAt: null,
              validUntil: null,
              payoutAmount: null,
            },
          },
        ),
      );
      expect(sent.statusLabel).toBe('Quote v4 sent');
    });
  });

  describe('FX-3.3 quote in the request projections (E-02, B-01)', () => {
    const quote = (overrides: object = {}) =>
      ({
        id: 'quote-1',
        version: 2,
        revision: 4,
        status: 'sent',
        items: [{ description: 'Labour', quantity: 2, unitPrice: 250000 }],
        total: 500000n,
        note: 'Scope note',
        pricingOverrideNote: 'No costing',
        lastEditedBy: 'staff-1',
        returnedNote: 'Check rates',
        publishedAt: now,
        validUntil: new Date('2026-11-06T10:00:00.000Z'),
        acceptedAt: null,
        paymentDueAt: null,
        payoutAmount: 300000n,
        payoutAssignmentId: 'assignment-1',
        ...overrides,
      }) as never;
    const assignment = {
      id: 'assignment-1',
      providerId: 'provider-1',
      providerUserId: 'user-1',
      status: 'accepted',
      source: 'auto',
      attempt: 1,
      score: {},
      note: null,
      offeredAt: now,
      expiresAt: now,
      sharedDetails: {},
    } as never;

    it('gives the customer id and the published fields, never a draft or internals', () => {
      const dto = customerProjection(
        context('customer', {
          quotes: [
            quote({ id: 'draft-3', version: 3, status: 'draft' }),
            quote(),
          ],
        }),
      );
      expect(dto.quote).toMatchObject({
        id: 'quote-1',
        version: 2,
        total: 500000,
        note: 'Scope note',
        validUntil: new Date('2026-11-06T10:00:00.000Z'),
      });
      for (const key of [
        'revision',
        'payoutAmount',
        'pricingOverrideNote',
        'lastEditedBy',
        'returnedNote',
      ])
        expect(dto.quote).not.toHaveProperty(key);
      const onlyDraft = customerProjection(
        context('customer', {
          quotes: [quote({ id: 'draft-3', version: 3, status: 'draft' })],
        }),
      );
      expect(onlyDraft.quote).toBeNull();
    });

    it('gives the provider scope lines and their own payout only', () => {
      const dto = providerProjection(
        context(
          'provider',
          { assignments: [assignment], quotes: [quote()] },
          { accessibleProviderUserIds: ['user-1'] },
        ),
      );
      expect(dto.quote).toEqual({
        id: 'quote-1',
        version: 2,
        status: 'sent',
        scope: [{ description: 'Labour', quantity: 2 }],
        payoutAmount: 300000,
      });
      const other = providerProjection(
        context(
          'provider',
          {
            assignments: [assignment],
            quotes: [quote({ payoutAssignmentId: 'assignment-9' })],
          },
          { accessibleProviderUserIds: ['user-1'] },
        ),
      );
      expect(other.quote).not.toHaveProperty('payoutAmount');
      expect(JSON.stringify(other.quote)).not.toContain('500000');
    });

    it('gives staff id and revision, the payout suggestion and blockedReason', () => {
      const contribution = {
        providerId: 'provider-1',
        assignmentId: 'assignment-1',
        total: 320000n,
        items: [],
        note: '',
      } as never;
      const priced = staffProjection(
        context(
          'staff',
          {
            assignments: [assignment],
            contributions: [contribution],
            quotes: [quote()],
          },
          {},
          ['view.pricing'],
        ),
      );
      expect(priced.quote).toMatchObject({
        id: 'quote-1',
        revision: 4,
        payoutSuggestion: 320000,
        blockedReason: null,
        amountsHidden: false,
      });
      const held = staffProjection({
        ...context(
          'staff',
          {
            quotes: [
              quote({
                status: 'draft',
                approvalRequestedAt: now,
                lastEditedBy: 'user-1',
              }),
            ],
          },
          {},
          ['view.pricing', 'quote.approve'],
        ),
      });
      expect(held.quote).toMatchObject({
        blockedReason: 'You edited this quote last.',
      });
      const masked = staffProjection(
        context('staff', { quotes: [quote()] }, {}, []),
      );
      expect(masked.quote).toMatchObject({
        id: 'quote-1',
        revision: 4,
        total: null,
        payoutAmount: null,
        amountsHidden: true,
      });
      for (const key of ['note', 'pricingOverrideNote', 'payoutSuggestion'])
        expect(masked.quote).not.toHaveProperty(key);
    });
  });
  describe('FX-3.11 cancellations[].refundStatus', () => {
    const cancellation = (id: string, refunds: string[]) =>
      ({
        id,
        status: 'approved',
        reasonCode: 'duplicate',
        note: 'Duplicate request',
        createdAt: now,
        refunds: refunds.map((status) => ({ status })),
      }) as never;

    it('is null for a cancellation without refunds', () => {
      const view = customerProjection(
        context('customer', { cancellations: [cancellation('c-1', [])] }),
      );
      expect(view.cancellations).toEqual([
        expect.objectContaining({ id: 'c-1', refundStatus: null }),
      ]);
    });

    it.each([
      [['pending_approval'], 'pending'],
      [['approved'], 'processing'],
      [['failed'], 'processing'],
      [['completed'], 'completed'],
      [['waived'], 'waived'],
    ])('shows the customer-safe status of %j as %s', (refunds, expected) => {
      const rows = { cancellations: [cancellation('c-1', refunds)] };
      for (const view of [
        customerProjection(context('customer', rows)),
        staffProjection(context('staff', rows)),
      ])
        expect(view.cancellations).toEqual([
          expect.objectContaining({ id: 'c-1', refundStatus: expected }),
        ]);
    });
  });

  describe('catalog answers', () => {
    const answer = (
      key: string,
      type: string,
      value: unknown,
      extra: Record<string, unknown> = {},
    ) => ({
      questionId: `q-${key}`,
      serviceId: 'svc-leaf',
      serviceName: 'Heavy equipment',
      key,
      label: key,
      type,
      value,
      display: String(value),
      sensitive: false,
      matchesSkill: false,
      ...extra,
    });
    const answers = [
      answer('trade', 'single_choice', 'Excavator', { matchesSkill: true }),
      answer('operator', 'yes_no', 'Yes'),
      answer('quantity', 'number', 2),
      answer('endDate', 'date', '2026-11-20', { dateRole: 'end' }),
      answer('notes', 'long_text', 'Soft ground at the back'),
      answer('access', 'long_text', 'Gate code 1234', { sensitive: true }),
    ];
    const rows = {
      details: {
        trade: 'Excavator',
        operator: 'Yes',
        quantity: 2,
        endDate: '2026-11-20',
        notes: 'Soft ground at the back',
        access: 'Gate code 1234',
      },
      answers,
      servicePath: [
        { id: 'svc-root', name: 'Hiring' },
        { id: 'svc-leaf', name: 'Heavy equipment' },
      ],
      service: 'Hiring',
      startDate: '2026-11-10',
    } as unknown as Partial<LoadedRequest>;

    it('shows staff without view.customer_contact no sensitive answers or details', () => {
      const dto = staffProjection(context('staff', rows));
      expect(dto.details).not.toHaveProperty('access');
      expect(dto.answers?.map(({ key }) => key)).toEqual([
        'trade',
        'operator',
        'quantity',
        'endDate',
        'notes',
      ]);
      expect(dto.servicePath).toEqual(rows.servicePath);
      expect(dto.effectiveEndDate).toBe('2026-11-20');
      expect(dto.effectiveStartDate).toBe('2026-11-10');
    });

    it('shows staff with view.customer_contact every answer', () => {
      const dto = staffProjection(
        context('staff', rows, {}, ['view.customer_contact']),
      );
      expect(dto.answers).toHaveLength(6);
      expect(dto.details).toHaveProperty('access', 'Gate code 1234');
    });

    it('gives customers their own answers and path', () => {
      const dto = customerProjection(context('customer', rows));
      expect(dto.answers).toHaveLength(6);
      expect(dto.servicePath).toEqual(rows.servicePath);
      expect(dto.effectiveEndDate).toBe('2026-11-20');
    });

    it('offers a provider only non-sensitive choice, yes/no and number answers', () => {
      const offered = {
        id: 'assignment-1',
        providerId: 'provider-1',
        providerUserId: 'user-1',
        status: 'offered',
        note: '',
        offeredAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        sharedDetails: null,
        createdAt: now,
      };
      const dto = providerProjection(
        context(
          'provider',
          { ...rows, assignments: [offered] as never },
          {
            accessibleProviderUserIds: ['user-1'],
            currentProviderUserId: 'user-1',
            currentAssignment: {
              status: 'offered',
              attempt: 1,
              expiresAt: offered.expiresAt,
            },
            assignments: [
              { status: 'offered', attempt: 1, expiresAt: offered.expiresAt },
            ],
          },
        ),
      );
      expect(dto.details).toEqual({
        trade: 'Excavator',
        operator: 'Yes',
        quantity: 2,
      });
      expect(dto.answers?.map(({ key }) => key)).toEqual([
        'trade',
        'operator',
        'quantity',
      ]);
      expect(dto.servicePath).toEqual(rows.servicePath);
    });
  });
});
