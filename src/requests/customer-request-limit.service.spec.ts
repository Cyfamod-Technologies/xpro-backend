import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import type { StaffPermission } from '../staff/staff-permissions';
import { AppError } from '../platform/errors/app-error';
import {
  CustomerRequestLimitService,
  REQUEST_LIMIT_NOTE_MESSAGE,
  REQUEST_LIMIT_RANGE_MESSAGE,
} from './customer-request-limit.service';

const STAFF_ID = 'staff-1';
const CUSTOMER_ID = 'customer-1';
const NOTE = 'Trusted repeat customer with many sites.';
const staffUser = { id: STAFF_ID } as RequestUser;

const actor = (
  permissions: StaffPermission[],
  status: 'active' | 'suspended' = 'active',
): ActorContext => ({
  userId: STAFF_ID,
  kind: 'staff',
  displayName: 'Staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status,
    roles: [],
    permissions: new Set(permissions),
    canOwn: false,
    isSuperAdmin: false,
    permVersion: 1,
  },
});

function setup(
  options: {
    actor?: ActorContext;
    target?: { openRequestLimit: number | null; roles: string[] } | null;
    open?: number;
    platform?: number;
  } = {},
) {
  const target =
    options.target === undefined
      ? { openRequestLimit: null, roles: ['customer'] }
      : options.target;
  const prisma = {
    user: {
      findUnique: jest.fn((args: { select: Record<string, unknown> }) =>
        Promise.resolve(
          args.select.platformRoles
            ? target && {
                openRequestLimit: target.openRequestLimit,
                platformRoles: target.roles.map((role) => ({ role })),
              }
            : { openRequestLimit: updated.value },
        ),
      ),
      update: jest.fn(
        ({ data }: { data: { openRequestLimit: number | null } }) => {
          updated.value = data.openRequestLimit;
          return Promise.resolve({});
        },
      ),
    },
    serviceRequest: {
      count: jest.fn().mockResolvedValue(options.open ?? 2),
    },
  };
  const updated = { value: target?.openRequestLimit ?? null };
  const audit = { record: jest.fn() };
  const service = new CustomerRequestLimitService(
    prisma as never,
    {
      resolve: jest
        .fn()
        .mockResolvedValue(options.actor ?? actor(['account.limit'])),
    } as never,
    {
      snapshot: jest.fn().mockResolvedValue([
        {
          key: 'request.maxOpenPerCustomer',
          value: options.platform ?? 3,
        },
      ]),
    } as never,
    audit as never,
  );
  return { service, prisma, audit };
}

async function failure(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected the call to be refused.');
}

describe('PUT /admin/customers/:userId/request-limit', () => {
  it('refuses staff without account.limit and writes nothing', async () => {
    const { service, prisma, audit } = setup({
      actor: actor(['settings.manage']),
    });
    const error = await failure(
      service.set(staffUser, CUSTOMER_ID, { limit: 5, note: NOTE }),
    );
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an inactive staff account and a non-staff caller', async () => {
    for (const caller of [
      actor(['account.limit'], 'suspended'),
      {
        userId: STAFF_ID,
        kind: 'customer',
        displayName: 'Customer',
        platformRoles: ['customer'],
        accountActive: true,
      } as ActorContext,
    ]) {
      const { service } = setup({ actor: caller });
      const error = await failure(
        service.set(staffUser, CUSTOMER_ID, { limit: 5, note: NOTE }),
      );
      expect(error.getStatus()).toBe(403);
    }
  });

  it('rejects a limit outside 1 to 50 or not a whole number with the exact message', async () => {
    for (const limit of [0, 51, 2.5, -1, '3', undefined, NaN]) {
      const { service, prisma } = setup();
      const error = await failure(
        service.set(staffUser, CUSTOMER_ID, {
          limit: limit as never,
          note: NOTE,
        }),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe(REQUEST_LIMIT_RANGE_MESSAGE);
      expect(error.message).toBe(
        'Choose a limit from 1 to 50, or leave it empty to use the default.',
      );
      expect(error.details).toEqual({ field: 'limit' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
  });

  it('accepts the boundaries 1 and 50', async () => {
    for (const limit of [1, 50]) {
      const { service } = setup();
      await expect(
        service.set(staffUser, CUSTOMER_ID, { limit, note: NOTE }),
      ).resolves.toMatchObject({ override: limit, effective: limit });
    }
  });

  it('rejects a note under 5 or over 500 characters, counting trimmed text', async () => {
    for (const note of [
      '',
      '    ',
      'abcd',
      '  abcd  ',
      'x'.repeat(501),
      undefined,
    ]) {
      const { service, prisma } = setup();
      const error = await failure(
        service.set(staffUser, CUSTOMER_ID, { limit: 5, note: note as never }),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.message).toBe(REQUEST_LIMIT_NOTE_MESSAGE);
      expect(error.message).toBe(
        'Add a note explaining why this limit changes.',
      );
      expect(error.details).toEqual({ field: 'note' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
    const { service } = setup();
    await expect(
      service.set(staffUser, CUSTOMER_ID, { limit: 5, note: 'x'.repeat(500) }),
    ).resolves.toBeDefined();
  });

  it('answers 404 for a missing user, a staff member and a provider-only account', async () => {
    for (const target of [
      null,
      { openRequestLimit: null, roles: ['customer', 'staff'] },
      { openRequestLimit: null, roles: ['provider'] },
    ]) {
      const { service, prisma, audit } = setup({ target });
      const error = await failure(
        service.set(staffUser, CUSTOMER_ID, { limit: 5, note: NOTE }),
      );
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('This customer was not found.');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    }
  });

  it('sets the override, audits before and after with the note and the actor, and returns the allowance', async () => {
    const { service, prisma, audit } = setup({
      target: { openRequestLimit: 2, roles: ['customer'] },
      open: 4,
      platform: 3,
    });
    const result = await service.set(staffUser, CUSTOMER_ID, {
      limit: 8,
      note: `  ${NOTE}  `,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID },
      data: { openRequestLimit: 8 },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'staff',
        actorId: STAFF_ID,
        entityId: CUSTOMER_ID,
        action: 'Customer request limit changed',
        metadata: {
          before: { limit: 2 },
          after: { limit: 8 },
          note: NOTE,
        },
      }),
    );
    expect(result).toEqual({
      userId: CUSTOMER_ID,
      override: 8,
      effective: 8,
      open: 4,
    });
  });

  it('clears the override with null and falls back to the platform setting', async () => {
    const { service, prisma, audit } = setup({
      target: { openRequestLimit: 8, roles: ['customer'] },
      open: 1,
      platform: 3,
    });
    const result = await service.set(staffUser, CUSTOMER_ID, {
      limit: null,
      note: NOTE,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID },
      data: { openRequestLimit: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          before: { limit: 8 },
          after: { limit: null },
          note: NOTE,
        },
      }),
    );
    expect(result).toEqual({
      userId: CUSTOMER_ID,
      override: null,
      effective: 3,
      open: 1,
    });
  });
});
