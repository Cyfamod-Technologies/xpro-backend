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
    quotes: [],
    currentSchedule: null,
    replacedSchedule: null,
    pendingUpdates: [],
    openIssues: [],
    pendingCancellation: false,
    latestNoShow: null,
    payment: { paid: false, pendingPaymentAt: null },
    payout: null,
    customerStanding: 'active',
    providerStanding: null,
    cascadePending: false,
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
    expect(dto.contributions).toBeUndefined();
    expect(dto).not.toHaveProperty('phone');
    expect(dto.budget).toBeNull();
    expect(dto.details).not.toHaveProperty('access');
    expect(dto).toHaveProperty('ownerId', 'customer-1');
  });
});
