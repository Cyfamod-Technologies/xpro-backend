import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  catalogRows,
  seededCatalog,
} from '../platform/catalog/catalog.testkit';
import type { CatalogIndex } from '../platform/catalog/catalog.types';
import type { ProviderProfileSubmissionDto } from './dto/provider.dto';
import { ProvidersService } from './providers.service';

const EXCAVATOR = 'svc:Hire/Heavy equipment:trade:Excavator';
const MASON = 'svc:Hire/Vocational worker:trade:Mason';
const INTERIOR = 'svc:Design/Interior design';

const file = (id: string, type = 'image/png') => ({
  id,
  name: id,
  type,
  size: 10,
});

function submission(
  over: Partial<ProviderProfileSubmissionDto> = {},
): ProviderProfileSubmissionDto {
  return {
    phone: '08000000000',
    trade: 'Builder',
    serviceAreaIds: ['district-1'],
    capacity: 2,
    workingHours: { mon: { start: '08:00', end: '17:00' } },
    experience: 3,
    bio: 'A careful builder with plenty of experience.',
    documents: [file('doc-1', 'application/pdf')],
    photo: file('photo-1'),
    bankCode: '058',
    accountNumber: '0123456789',
    ...over,
  };
}

function setup(
  options: {
    catalog?: CatalogIndex;
    live?: Record<string, unknown> | null;
    stubProfile?: boolean;
  } = {},
) {
  const catalog = options.catalog ?? seededCatalog();
  const saved = (data: Record<string, unknown>) => ({
    id: 'profile-1',
    version: 1,
    ...data,
  });
  const tx = {
    providerProfile: {
      findUnique: jest.fn().mockResolvedValue(options.live ?? null),
      upsert: jest.fn((args: { create: Record<string, unknown> }) =>
        Promise.resolve(saved(args.create)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(saved(args.data)),
      ),
    },
    providerBankAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    providerReview: { create: jest.fn() },
    providerUpload: { updateMany: jest.fn() },
  };
  const prisma = {
    catalogService: {
      findMany: jest.fn().mockResolvedValue(catalogRows(catalog)),
    },
    providerProfile: {
      findUnique: jest.fn().mockResolvedValue(options.live ?? null),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const audit = { record: jest.fn() };
  const locations = {
    resolveProviderLocationIds: jest.fn().mockResolvedValue({
      cityName: 'Lagos',
      cityId: 'city-1',
      serviceAreaNames: ['Ikeja'],
      serviceAreaIds: ['district-1'],
    }),
  };
  const service = new ProvidersService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    locations as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service as never, 'requireProvider' as never).mockResolvedValue({
    id: 'user-1',
    emailVerifiedAt: new Date(),
  } as never);
  jest
    .spyOn(service as never, 'verifyAttachments' as never)
    .mockResolvedValue(undefined as never);
  jest.spyOn(service as never, 'resolveBank' as never).mockResolvedValue({
    bankName: 'GTBank',
    accountName: 'A Provider',
  } as never);
  if (options.stubProfile !== false)
    jest.spyOn(service, 'myProfile').mockResolvedValue({} as never);
  return { service, prisma, tx, catalog };
}

describe('ProvidersService', () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  type Upsert = {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };
  const upserted = (tx: ReturnType<typeof setup>['tx']) =>
    tx.providerProfile.upsert.mock.calls[0][0] as unknown as Upsert;
  const created = (tx: ReturnType<typeof setup>['tx']) => upserted(tx).create;

  describe('submit by ids', () => {
    it('stores the ids and a snapshot of the names', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Hire', 'svc:Design', 'svc:Hire'],
          skillIds: {
            'svc:Hire': [EXCAVATOR, MASON, EXCAVATOR],
            'svc:Design': [INTERIOR],
          },
        }),
      );
      const data = created(tx);
      expect(data.serviceIds).toEqual(['svc:Hire', 'svc:Design']);
      expect(data.skillIds).toEqual({
        'svc:Hire': [EXCAVATOR, MASON],
        'svc:Design': [INTERIOR],
      });
      expect(data.services).toEqual(['Hire', 'Design']);
      expect(data.skills).toEqual({
        Hire: ['Excavator', 'Mason'],
        Design: ['Interior design'],
      });
      const { update } = upserted(tx);
      expect(update.serviceIds).toEqual(data.serviceIds);
      expect(update.skillIds).toEqual(data.skillIds);
    });

    it('drops skill keys for services that were not chosen', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': [INTERIOR], 'svc:Hire': [EXCAVATOR] },
        }),
      );
      expect(created(tx).skillIds).toEqual({ 'svc:Design': [INTERIOR] });
    });

    it.each([
      [
        'an unknown service id',
        { serviceIds: ['nope'], skillIds: {} },
        'Choose services from the list.',
      ],
      [
        'a service that is not a top-level service',
        { serviceIds: ['svc:Hire/Professional'], skillIds: {} },
        'Choose services from the list.',
      ],
      [
        'a skill id from another service',
        { serviceIds: ['svc:Design'], skillIds: { 'svc:Design': [EXCAVATOR] } },
        'Choose Design skills from the list.',
      ],
      [
        'a skill name instead of an id',
        {
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': ['Excavator'] },
        },
        'Choose Design skills from the list.',
      ],
      [
        'skills that are not a list',
        {
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': INTERIOR as never },
        },
        'Choose Design skills from the list.',
      ],
      [
        'no skill for a service that has skills',
        { serviceIds: ['svc:Design'], skillIds: {} },
        'Choose at least one skill for Design.',
      ],
      [
        'no services',
        { serviceIds: [], skillIds: {} },
        'Choose at least one service.',
      ],
    ])('rejects %s', async (_name, input, message) => {
      const { service, tx } = setup();
      await expect(service.submit('user-1', submission(input))).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
    });

    it('rejects an inactive service, skill, or option', async () => {
      const catalog = seededCatalog();
      catalog.byId.get('svc:Design')!.active = false;
      catalog.byId.get(
        'svc:Hire/Heavy equipment',
      )!.questions[0].options[0].active = false;
      const { service } = setup({ catalog });
      await expect(
        service.submit(
          'user-1',
          submission({ serviceIds: ['svc:Design'], skillIds: {} }),
        ),
      ).rejects.toThrow('Choose services from the list.');
      await expect(
        service.submit(
          'user-1',
          submission({
            serviceIds: ['svc:Hire'],
            skillIds: { 'svc:Hire': [EXCAVATOR] },
          }),
        ),
      ).rejects.toThrow('Choose Hire skills from the list.');
    });

    it('needs no skill for a service that has none to choose', async () => {
      const catalog = seededCatalog();
      for (const child of catalog.byId.get('svc:Design')!.children)
        catalog.byId.delete(child.id);
      const { service, tx } = setup({ catalog });
      await service.submit(
        'user-1',
        submission({ serviceIds: ['svc:Design'], skillIds: {} }),
      );
      expect(created(tx).skillIds).toEqual({ 'svc:Design': [] });
      expect(created(tx).skills).toEqual({ Design: [] });
    });
  });

  describe('submit by legacy names', () => {
    it('converts names to ids and keeps the names as the snapshot', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          services: ['Hire', 'Design'],
          skills: { Hire: ['Excavator'], Design: ['Interior design'] },
        }),
      );
      const data = created(tx);
      expect(data.serviceIds).toEqual(['svc:Hire', 'svc:Design']);
      expect(data.skillIds).toEqual({
        'svc:Hire': [EXCAVATOR],
        'svc:Design': [INTERIOR],
      });
      expect(data.services).toEqual(['Hire', 'Design']);
    });

    it('prefers ids when both are sent', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          services: ['Hire'],
          skills: { Hire: ['Excavator'] },
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': [INTERIOR] },
        }),
      );
      expect(created(tx).serviceIds).toEqual(['svc:Design']);
    });

    it.each([
      [
        'an unknown service name',
        { services: ['Gardening'], skills: { Gardening: ['Lawns'] } },
        'Gardening is not a service XPro offers.',
      ],
      [
        'an unknown skill name',
        { services: ['Hire'], skills: { Hire: ['Wizard'] } },
        'Choose Hire skills from the list.',
      ],
      [
        'a skill that belongs to another service',
        { services: ['Design'], skills: { Design: ['Excavator'] } },
        'Choose Design skills from the list.',
      ],
      [
        'no skills for a service that has skills',
        { services: ['Hire'], skills: {} },
        'Choose at least one skill for Hire.',
      ],
      ['no services at all', {}, 'Choose at least one service.'],
    ])('rejects %s', async (_name, input, message) => {
      const { service } = setup();
      await expect(service.submit('user-1', submission(input))).rejects.toThrow(
        new BadRequestException(message),
      );
    });
  });

  describe('a live profile that is already approved', () => {
    const live = { id: 'profile-1', verification: 'approved', version: 3 };

    it('holds the ids and refreshed names in pendingChanges, not in the live columns', async () => {
      const { service, tx } = setup({ live });
      await service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Hire'],
          skillIds: { 'svc:Hire': [EXCAVATOR] },
        }),
      );
      const data = (
        tx.providerProfile.update.mock.calls[0][0] as {
          data: { pendingChanges: Record<string, unknown> } & Record<
            string,
            unknown
          >;
        }
      ).data;
      expect(data.pendingChanges).toMatchObject({
        serviceIds: ['svc:Hire'],
        skillIds: { 'svc:Hire': [EXCAVATOR] },
        services: ['Hire'],
        skills: { Hire: ['Excavator'] },
      });
      expect(data).not.toHaveProperty('serviceIds');
      expect(data).not.toHaveProperty('skillIds');
      expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
    });
  });

  describe('reviewChanges', () => {
    const reviewer = async (pendingChanges: Record<string, unknown>) => {
      const harness = setup();
      const profile = {
        id: 'profile-1',
        version: 4,
        pendingChanges: {
          trade: 'Builder',
          serviceAreas: ['Ikeja'],
          capacity: 2,
          documents: [],
          photo: file('photo-1'),
          ...pendingChanges,
        },
      };
      harness.prisma.providerProfile.findUnique.mockResolvedValue(profile);
      jest
        .spyOn(harness.service as never, 'requirePermission' as never)
        .mockResolvedValue(undefined as never);
      jest
        .spyOn(harness.service as never, 'myProfileById' as never)
        .mockResolvedValue({} as never);
      await harness.service.reviewChanges('staff-1', 'profile-1', {
        approve: true,
        note: 'Looks right.',
        expectedVersion: 4,
      });
      return harness.tx.providerProfile.update.mock.calls[0][0].data;
    };

    it('copies the ids next to the names when it approves', async () => {
      const data = await reviewer({
        services: ['Hire'],
        serviceIds: ['svc:Hire'],
        skills: { Hire: ['Excavator'] },
        skillIds: { 'svc:Hire': [EXCAVATOR] },
      });
      expect(data.serviceIds).toEqual(['svc:Hire']);
      expect(data.skillIds).toEqual({ 'svc:Hire': [EXCAVATOR] });
      expect(data.services).toEqual(['Hire']);
      expect(data.pendingChanges).toBe(Prisma.DbNull);
    });

    it('clears the live ids when the change predates them, so readers use its names', async () => {
      const data = await reviewer({
        services: ['Hire'],
        skills: { Hire: ['Excavator'] },
      });
      expect(data.serviceIds).toBe(Prisma.DbNull);
      expect(data.skillIds).toBe(Prisma.DbNull);
    });
  });

  describe('myProfile', () => {
    it('returns the current names for stored ids, so a rename shows at once', async () => {
      const catalog = seededCatalog();
      catalog.byId.get(
        'svc:Hire/Heavy equipment',
      )!.questions[0].options[0].label = 'Excavator (20t)';
      catalog.byId.get('svc:Hire')!.name = 'Hire and rental';
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        services: ['Hire'],
        serviceIds: ['svc:Hire'],
        skills: { Hire: ['Excavator'] },
        skillIds: { 'svc:Hire': [EXCAVATOR] },
        pendingChanges: {
          trade: 'Builder',
          submittedAt: 'earlier',
          services: ['Hire'],
          serviceIds: ['svc:Hire'],
          skills: { Hire: ['Excavator', 'Mason'] },
          skillIds: { 'svc:Hire': [EXCAVATOR, MASON] },
        },
        bankAccounts: [],
        reviews: [],
      };
      const { service } = setup({ catalog, live: row, stubProfile: false });
      const profile = (await service.myProfile('user-1')) as unknown as Record<
        string,
        unknown
      >;
      expect(profile).toMatchObject({
        services: ['Hire and rental'],
        serviceIds: ['svc:Hire'],
        skills: { 'Hire and rental': ['Excavator (20t)'] },
        skillIds: { 'svc:Hire': [EXCAVATOR] },
        pendingChanges: {
          submittedAt: 'earlier',
          services: ['Hire and rental'],
          skills: { 'Hire and rental': ['Excavator (20t)', 'Mason'] },
          skillIds: { 'svc:Hire': [EXCAVATOR, MASON] },
        },
      });
    });

    it('resolves a not-yet-backfilled profile from its names', async () => {
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        services: ['Hire'],
        serviceIds: null,
        skills: { Hire: ['Excavator'] },
        skillIds: null,
        pendingChanges: null,
        bankAccounts: [],
        reviews: [],
      };
      const { service } = setup({ live: row, stubProfile: false });
      const profile = (await service.myProfile('user-1')) as unknown as Record<
        string,
        unknown
      >;
      expect(profile).toMatchObject({
        serviceIds: ['svc:Hire'],
        skillIds: { 'svc:Hire': [EXCAVATOR] },
        services: ['Hire'],
        skills: { Hire: ['Excavator'] },
      });
    });
  });
});
