import type { Upload } from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import type { StaffPermission } from '../staff/staff-permissions';
import {
  PAYMENT_ENTITY,
  PAYOUT_ENTITY,
  REFUND_ENTITY,
} from '../uploads/entity-types';
import type { UploadAccessResolver } from '../uploads/file-access.service';
import { PaymentsFileAccess } from './payments-file-access';

const staff = (
  permissions: StaffPermission[],
  isSuperAdmin = false,
): ActorContext =>
  ({
    userId: 'staff-1',
    kind: 'staff',
    displayName: 'Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status: 'active',
      roles: [],
      permissions: new Set(permissions),
      canOwn: false,
      isSuperAdmin,
      permVersion: 1,
    },
  }) as unknown as ActorContext;
const customer = {
  userId: 'customer-1',
  kind: 'customer',
  displayName: 'Customer',
  platformRoles: ['customer'],
  accountActive: true,
} as unknown as ActorContext;

function setup(actor: ActorContext, rowExists = true) {
  const resolvers = new Map<string, UploadAccessResolver>();
  const find = jest.fn().mockResolvedValue(rowExists ? { id: 'e-1' } : null);
  const prisma = {
    payment: { findUnique: find },
    refund: { findUnique: find },
    payout: { findUnique: find },
  };
  new PaymentsFileAccess(
    {
      register: (type: string, resolver: UploadAccessResolver) =>
        resolvers.set(type, resolver),
    } as never,
    prisma as never,
    { resolve: () => Promise.resolve(actor) } as never,
  ).onModuleInit();
  const can = (type: string, entityId: string | null = 'e-1') =>
    resolvers.get(type)!(
      { id: 'u' } as unknown as RequestUser,
      { id: 'upload-1', entityId } as unknown as Upload,
    );
  return { resolvers, can, find };
}

describe('PaymentsFileAccess', () => {
  it('registers resolvers for the payment, refund and payout entities', () => {
    const { resolvers } = setup(customer);
    expect([...resolvers.keys()].sort()).toEqual(
      [PAYMENT_ENTITY, PAYOUT_ENTITY, REFUND_ENTITY].sort(),
    );
  });

  it('opens each proof for the permission that owns it', async () => {
    await expect(
      setup(staff(['payment.record'])).can(PAYMENT_ENTITY),
    ).resolves.toBe(true);
    await expect(
      setup(staff(['refund.manage'])).can(REFUND_ENTITY),
    ).resolves.toBe(true);
    await expect(
      setup(staff(['payout.approve'])).can(PAYOUT_ENTITY),
    ).resolves.toBe(true);
  });

  it('refuses a permission that belongs to another entity', async () => {
    await expect(
      setup(staff(['payment.record'])).can(PAYOUT_ENTITY),
    ).resolves.toBe(false);
  });

  it('opens every proof for a super admin', async () => {
    const { can } = setup(staff([], true));
    await expect(can(PAYMENT_ENTITY)).resolves.toBe(true);
    await expect(can(REFUND_ENTITY)).resolves.toBe(true);
    await expect(can(PAYOUT_ENTITY)).resolves.toBe(true);
  });

  it('refuses customers and uploads without an entity id or row', async () => {
    await expect(setup(customer).can(PAYMENT_ENTITY)).resolves.toBe(false);
    await expect(
      setup(staff(['payment.record'])).can(PAYMENT_ENTITY, null),
    ).resolves.toBe(false);
    await expect(
      setup(staff(['payment.record']), false).can(PAYMENT_ENTITY),
    ).resolves.toBe(false);
  });
});
