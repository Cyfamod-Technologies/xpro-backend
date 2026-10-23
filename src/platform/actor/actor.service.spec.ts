import { PrismaService } from '../../prisma/prisma.service';
import { STAFF_PERMISSIONS } from '../../staff/staff-permissions';
import { AppError } from '../errors/app-error';
import { ActorService } from './actor.service';
import { ENGINE_ACTOR, SYSTEM_ACTOR } from './actor.types';

type UserRow = {
  status: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
  platformRoles: { role: string }[];
  staffMember: {
    status: string;
    permVersion: number;
    roles: { role: string }[];
  } | null;
};

function setup(row: Partial<UserRow> | null) {
  const findUnique = jest.fn().mockResolvedValue(
    row && {
      status: 'active',
      firstName: 'Ada',
      lastName: 'Obi',
      name: null,
      email: 'ada@example.com',
      platformRoles: [],
      staffMember: null,
      ...row,
    },
  );
  const service = new ActorService({
    user: { findUnique },
  } as never as PrismaService);
  return { service, findUnique };
}

describe('ActorService.resolve', () => {
  it('resolves a customer in one query', async () => {
    const { service, findUnique } = setup({
      platformRoles: [{ role: 'customer' }],
    });
    const actor = await service.resolve('u1');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(actor).toMatchObject({
      userId: 'u1',
      kind: 'customer',
      displayName: 'Ada Obi',
      platformRoles: ['customer'],
      accountActive: true,
    });
    expect(actor.staff).toBeUndefined();
  });

  it('treats a provider who is also a customer as a provider with both roles', async () => {
    const { service } = setup({
      platformRoles: [{ role: 'customer' }, { role: 'provider' }],
    });
    const actor = await service.resolve('u1');
    expect(actor.kind).toBe('provider');
    expect(actor.platformRoles).toEqual(['customer', 'provider']);
  });

  it('resolves active staff with permissions from their roles', async () => {
    const { service } = setup({
      platformRoles: [{ role: 'staff' }],
      staffMember: {
        status: 'active',
        permVersion: 3,
        roles: [{ role: 'pricing' }],
      },
    });
    const actor = await service.resolve('u1');
    expect(actor.kind).toBe('staff');
    expect(actor.staff).toMatchObject({
      status: 'active',
      roles: ['pricing'],
      canOwn: false,
      isSuperAdmin: false,
      permVersion: 3,
    });
    expect(actor.staff?.permissions.has('quote.manage')).toBe(true);
    expect(actor.staff?.permissions.has('dispatch.manage')).toBe(false);
  });

  it('gives a suspended staff member no permissions', async () => {
    const { service } = setup({
      platformRoles: [{ role: 'staff' }],
      staffMember: {
        status: 'suspended',
        permVersion: 2,
        roles: [{ role: 'operations' }],
      },
    });
    const actor = await service.resolve('u1');
    expect(actor.kind).toBe('staff');
    expect(actor.staff?.status).toBe('suspended');
    expect(actor.staff?.permissions.size).toBe(0);
    expect(actor.staff?.canOwn).toBe(false);
  });

  it('gives an active super admin every permission', async () => {
    const { service } = setup({
      platformRoles: [{ role: 'staff' }],
      staffMember: {
        status: 'active',
        permVersion: 1,
        roles: [{ role: 'super_admin' }],
      },
    });
    const actor = await service.resolve('u1');
    expect(actor.staff?.isSuperAdmin).toBe(true);
    expect(actor.staff?.canOwn).toBe(true);
    expect([...(actor.staff?.permissions ?? [])].sort()).toEqual(
      [...STAFF_PERMISSIONS].sort(),
    );
  });

  it('ignores a staff member row without the staff platform role', async () => {
    const { service } = setup({
      platformRoles: [{ role: 'customer' }],
      staffMember: {
        status: 'active',
        permVersion: 1,
        roles: [{ role: 'finance' }],
      },
    });
    expect((await service.resolve('u1')).staff).toBeUndefined();
  });

  it('flags an account that is not active', async () => {
    const { service } = setup({
      status: 'suspended',
      platformRoles: [{ role: 'customer' }],
    });
    expect((await service.resolve('u1')).accountActive).toBe(false);
  });

  it('falls back to the email when the user has no name', async () => {
    const { service } = setup({
      firstName: null,
      lastName: null,
      platformRoles: [{ role: 'customer' }],
    });
    expect((await service.resolve('u1')).displayName).toBe('ada@example.com');
  });

  it('refuses an unknown user', async () => {
    const { service } = setup(null);
    await expect(service.resolve('missing')).rejects.toBeInstanceOf(AppError);
  });
});

describe('system actors', () => {
  it('names the system and the engine', () => {
    expect(SYSTEM_ACTOR).toMatchObject({
      userId: null,
      kind: 'system',
      displayName: 'XPro system',
    });
    expect(ENGINE_ACTOR).toMatchObject({
      userId: null,
      kind: 'system',
      displayName: 'Auto-assign rules v1',
    });
  });
});
