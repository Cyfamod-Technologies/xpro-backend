import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { createStaff, deleteTestUsers } from '../../test/integration/users';
import { StaffRoutingService } from './staff-routing.service';

describe('StaffRoutingService (integration)', () => {
  let prisma: PrismaService;
  let routing: StaffRoutingService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [StaffRoutingService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    routing = moduleRef.get(StaffRoutingService);
  });

  afterEach(async () => {
    await deleteTestUsers(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const sorted = (ids: string[]) => [...ids].sort();

  it('rule 1: routes to the owner alone when the owner holds the permission', async () => {
    const owner = await createStaff(prisma, ['operations']);
    await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: owner.id,
      permission: 'progress.review',
      actorId: null,
    });

    expect(result).toEqual([owner.id]);
  });

  it('rule 1: an owner without the permission is told as information, with every holder', async () => {
    const owner = await createStaff(prisma, ['client_relations']);
    const holderA = await createStaff(prisma, ['operations']);
    const holderB = await createStaff(prisma, ['operations']);
    await createStaff(prisma, ['pricing']);

    const result = await routing.audience('gated', {
      ownerId: owner.id,
      permission: 'progress.review',
      actorId: null,
    });

    expect(sorted(result)).toEqual(sorted([owner.id, holderA.id, holderB.id]));
  });

  it('rule 1: an unclaimed request goes to every holder', async () => {
    const holderA = await createStaff(prisma, ['operations']);
    const holderB = await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: null,
      permission: 'dispatch.manage',
      actorId: null,
    });

    expect(sorted(result)).toEqual(sorted([holderA.id, holderB.id]));
  });

  it('rule 1: a suspended owner is treated as having no owner', async () => {
    const owner = await createStaff(prisma, ['operations'], {
      status: 'suspended',
    });
    const holder = await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: owner.id,
      permission: 'progress.review',
      actorId: null,
    });

    expect(result).toEqual([holder.id]);
  });

  it('rule 2: every active holder, not tied to a request', async () => {
    const finance = await createStaff(prisma, ['finance']);
    await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated_unscoped', {
      ownerId: null,
      permission: 'bank.review',
      actorId: null,
    });

    expect(result).toEqual([finance.id]);
  });

  it('rule 3: informational events go to the owner, or to everyone who can own', async () => {
    const owner = await createStaff(prisma, ['operations']);
    const other = await createStaff(prisma, ['operations']);
    await createStaff(prisma, ['pricing']);

    expect(
      await routing.audience('informational', {
        ownerId: owner.id,
        actorId: null,
      }),
    ).toEqual([owner.id]);
    expect(
      sorted(
        await routing.audience('informational', {
          ownerId: null,
          actorId: null,
        }),
      ),
    ).toEqual(sorted([owner.id, other.id]));
  });

  it('rule 4: pricing events go to quote.manage holders plus the owner', async () => {
    const owner = await createStaff(prisma, ['operations']);
    const pricing = await createStaff(prisma, ['pricing']);
    await createStaff(prisma, ['finance']);

    const result = await routing.audience('pricing', {
      ownerId: owner.id,
      actorId: null,
    });

    expect(sorted(result)).toEqual(sorted([owner.id, pricing.id]));
  });

  it('rule 5: customer messages go to the owner and Client relations members', async () => {
    const owner = await createStaff(prisma, ['operations']);
    const clientRelations = await createStaff(prisma, ['client_relations']);
    await createStaff(prisma, ['operations']);

    const result = await routing.audience('customer_message', {
      ownerId: owner.id,
      actorId: null,
    });

    expect(sorted(result)).toEqual(sorted([owner.id, clientRelations.id]));
  });

  it('rule 6: excludes the actor', async () => {
    const actor = await createStaff(prisma, ['operations']);
    const other = await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: null,
      permission: 'progress.review',
      actorId: actor.id,
    });

    expect(result).toEqual([other.id]);
  });

  it('rule 6: leaves out members whose only source is super_admin when others hold it', async () => {
    await createStaff(prisma, ['super_admin']);
    const ops = await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: null,
      permission: 'progress.review',
      actorId: null,
    });

    expect(result).toEqual([ops.id]);
  });

  it('rule 6: keeps a super admin who also holds the permission through another role', async () => {
    const both = await createStaff(prisma, ['super_admin', 'operations']);

    const result = await routing.audience('gated', {
      ownerId: null,
      permission: 'progress.review',
      actorId: null,
    });

    expect(result).toEqual([both.id]);
  });

  it('rule 6: falls back to super admins when nobody else holds the permission', async () => {
    const superAdmin = await createStaff(prisma, ['super_admin']);
    await createStaff(prisma, ['operations']);

    const result = await routing.audience('gated', {
      ownerId: null,
      permission: 'settings.manage',
      actorId: null,
    });

    expect(result).toEqual([superAdmin.id]);
  });

  it('requires a permission for the gated rules', async () => {
    await expect(
      routing.audience('gated', { ownerId: null, actorId: null }),
    ).rejects.toThrow('deciding permission');
  });
});
