import { RequestStatus, StaffRole, StaffStatus } from '@prisma/client';
import { V1Service } from './v1.service';

const customerActor = {
  kind: 'customer',
  userId: 'customer-1',
  platformRoles: ['customer'],
};

function setup(latestOffer: Record<string, unknown> | null = null) {
  const updatedRequest = { id: 'request-1', version: 5 };
  const currentRequest = {
    id: 'request-1',
    version: 4,
    status: RequestStatus.submitted,
  };
  const tx = {
    $executeRaw: jest.fn(),
    requestCounterOffer: {
      findFirst: jest.fn().mockResolvedValue(latestOffer),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    quote: {
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 3 } }),
      create: jest.fn().mockResolvedValue({}),
    },
    serviceRequest: {
      findFirstOrThrow: jest.fn().mockResolvedValue(updatedRequest),
    },
  };
  const audit = { record: jest.fn() };
  const idempotency = { lookup: jest.fn().mockResolvedValue(null) };
  const service = new V1Service(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
    idempotency as never,
  );
  const internals = service as unknown as Record<string, jest.Mock>;
  internals.actor = jest.fn().mockResolvedValue(customerActor);
  internals.replayCommand = jest.fn().mockResolvedValue(null);
  internals.findRequest = jest.fn().mockResolvedValue(currentRequest);
  internals.runIdempotent = jest.fn(async (...args: unknown[]) => ({
    value: await (args[4] as (db: typeof tx) => Promise<unknown>)(tx),
    replayed: false,
  }));
  internals.bumpVersion = jest.fn().mockResolvedValue(undefined);
  internals.projectRequest = jest.fn().mockResolvedValue(updatedRequest);

  return { service, tx, audit, internals, currentRequest, updatedRequest };
}

const commandRequest = {
  method: 'POST',
  originalUrl: '/requests/XPR-00001/offers/offer-1/accept',
  body: {},
} as never;

describe('V1Service.acceptOffer', () => {
  it('atomically records the latest XPro offer as the accepted canonical quote', async () => {
    const offer = {
      id: 'offer-1',
      authorRole: 'admin',
      amountKobo: 620_000n,
      note: 'Weekend work adds two days.',
      acceptedAt: null,
    };
    const { service, tx, audit, internals, updatedRequest } = setup(offer);

    await expect(
      service.acceptOffer(
        'customer-1',
        'XPR-00001',
        'offer-1',
        4,
        'idem-accept-1',
        commandRequest,
      ),
    ).resolves.toEqual(updatedRequest);

    expect(tx.requestCounterOffer.updateMany).toHaveBeenCalledTimes(1);
    const offerUpdateCalls = tx.requestCounterOffer.updateMany.mock
      .calls as unknown as Array<
      [
        {
          where: { id: string; acceptedAt: null };
          data: { acceptedAt: Date; acceptedBy: string };
        },
      ]
    >;
    const acceptedOfferUpdate = offerUpdateCalls[0][0];
    expect(acceptedOfferUpdate.where).toMatchObject({
      id: 'offer-1',
      acceptedAt: null,
    });
    expect(acceptedOfferUpdate.data.acceptedAt).toBeInstanceOf(Date);
    expect(acceptedOfferUpdate.data.acceptedBy).toBe('customer-1');
    expect(tx.quote.create).toHaveBeenCalledTimes(1);
    const quoteCreateCalls = tx.quote.create.mock.calls as unknown as Array<
      [
        {
          data: {
            requestId: string;
            version: number;
            status: string;
            total: bigint;
            note: string;
            lastEditedBy: string;
          };
        },
      ]
    >;
    const acceptedQuote = quoteCreateCalls[0][0];
    expect(acceptedQuote.data).toMatchObject({
      requestId: 'request-1',
      version: 4,
      status: 'accepted',
      total: 620_000n,
      note: offer.note,
      lastEditedBy: 'customer-1',
    });
    expect(internals.bumpVersion).toHaveBeenCalledWith(tx, 'request-1', 4);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'v1.offer.accepted',
        entityId: 'offer-1',
      }),
    );
  });

  it('rejects a customer counter, a superseded offer or an already accepted offer', async () => {
    for (const offer of [
      { id: 'offer-1', authorRole: 'customer', acceptedAt: null },
      { id: 'offer-2', authorRole: 'admin', acceptedAt: null },
      { id: 'offer-1', authorRole: 'admin', acceptedAt: new Date() },
    ]) {
      const { service, tx } = setup({
        ...offer,
        amountKobo: 500_000n,
        supersededById: null,
      });

      await expect(
        service.acceptOffer(
          'customer-1',
          'XPR-00001',
          'offer-1',
          4,
          'idem-accept-2',
          commandRequest,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_AVAILABLE' });
      expect(tx.quote.create).not.toHaveBeenCalled();
    }
  });
});

describe('V1Service.assignStaff', () => {
  const adminActor = {
    kind: 'staff',
    userId: 'admin-1',
    displayName: 'Admin User',
    staff: {
      status: StaffStatus.active,
      roles: [StaffRole.super_admin],
      permissions: new Set(['staff.manage']),
      canOwn: true,
      isSuperAdmin: true,
      permVersion: 1,
    },
  };
  const currentRequest = {
    id: 'request-1',
    version: 4,
    status: RequestStatus.submitted,
    staffOwnerId: null,
  };
  const updatedRequest = { id: 'request-1', version: 5 };
  const commandRequest = {
    method: 'POST',
    originalUrl: '/requests/XPR-00001/reassign',
    body: { staffId: 'operations-1', expectedOwnerId: null },
  } as never;

  function setupAssignment(member: Record<string, unknown> | null) {
    const staffMember = { findFirst: jest.fn().mockResolvedValue(member) };
    const prisma = { staffMember };
    const tx = {
      requestActivity: { create: jest.fn().mockResolvedValue({}) },
      serviceRequest: {
        findFirstOrThrow: jest.fn().mockResolvedValue(updatedRequest),
      },
    };
    const audit = { record: jest.fn() };
    const idempotency = { lookup: jest.fn().mockResolvedValue(null) };
    const service = new V1Service(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      idempotency as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.actor = jest.fn().mockResolvedValue(adminActor);
    internals.replayCommand = jest.fn().mockResolvedValue(null);
    internals.findRequest = jest.fn().mockResolvedValue(currentRequest);
    internals.runIdempotent = jest.fn(async (...args: unknown[]) => ({
      value: await (args[4] as (db: typeof tx) => Promise<unknown>)(tx),
      replayed: false,
    }));
    internals.bumpVersion = jest.fn().mockResolvedValue(undefined);
    internals.projectRequest = jest.fn().mockResolvedValue(updatedRequest);

    return { service, staffMember, tx, audit };
  }

  it('assigns an active Operations member based on current roles, not the stale owner flag', async () => {
    const { service, staffMember, tx, audit } = setupAssignment({
      userId: 'operations-1',
      status: StaffStatus.active,
      canOwnRequests: false,
      roles: [{ role: StaffRole.operations }],
      user: {
        firstName: 'Ada',
        lastName: 'Okafor',
        name: null,
        email: 'ada@example.com',
      },
    });

    await expect(
      service.assignStaff(
        'admin-1',
        'XPR-00001',
        { staffId: 'operations-1', expectedOwnerId: null },
        4,
        'idem-assign-1',
        commandRequest,
      ),
    ).resolves.toEqual(updatedRequest);

    const [[eligibilityQuery]] = staffMember.findFirst.mock
      .calls as unknown as Array<
      [
        {
          where: Record<string, unknown>;
        },
      ]
    >;
    expect(eligibilityQuery.where).not.toHaveProperty('canOwnRequests');
    expect(tx.requestActivity.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'v1.request.staff_assigned' }),
    );
  });

  it('rejects an active staff member whose roles cannot own requests', async () => {
    const { service } = setupAssignment({
      userId: 'pricing-1',
      status: StaffStatus.active,
      roles: [{ role: StaffRole.pricing }],
      user: {
        firstName: 'Pat',
        lastName: 'Pricing',
        name: null,
        email: 'pat@example.com',
      },
    });

    await expect(
      service.assignStaff(
        'admin-1',
        'XPR-00001',
        { staffId: 'pricing-1', expectedOwnerId: null },
        4,
        'idem-assign-2',
        commandRequest,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Choose an active staff member who can own requests.',
    });
  });
});
