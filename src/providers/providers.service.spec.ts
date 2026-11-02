import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  catalogRows,
  seededCatalog,
} from '../platform/catalog/catalog.testkit';
import type { CatalogIndex } from '../platform/catalog/catalog.types';
import type { ProviderProfileSubmissionDto } from './dto/provider.dto';
import { ProvidersService } from './providers.service';

const EXCAVATOR = 'svc:Hiring/Heavy equipment:trade:Excavator';
const MASON = 'svc:Hiring/Vocational worker:trade:Mason';
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
    phone: '08031234567',
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
    requirePhoneVerification?: boolean;
    requireEmailVerification?: boolean;
    emailVerified?: boolean;
    outsideServed?: boolean;
  } = {},
) {
  const catalog = options.catalog ?? seededCatalog();
  const saved = (data: Record<string, unknown>) => ({
    id: 'profile-1',
    version: 1,
    ...data,
  });
  const settingLookup = ({ where }: { where: { key: string } }) => {
    if (where.key === 'provider.requirePhoneVerification')
      return Promise.resolve(
        options.requirePhoneVerification ? { value: true } : null,
      );
    if (where.key === 'provider.requireEmailVerification')
      return Promise.resolve(
        options.requireEmailVerification === false ? { value: false } : null,
      );
    return Promise.resolve(null);
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    setting: { findUnique: jest.fn(settingLookup) },
    phoneVerification: { updateMany: jest.fn() },
    user: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        emailVerifiedAt: options.emailVerified === false ? null : new Date(),
        phoneE164: '+2348031234567',
        phoneVerifiedAt: new Date(),
      }),
    },
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
    location: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => id === 'lga-1').map((id) => ({ id })),
        ),
      ),
    },
  };
  const prisma = {
    setting: { findUnique: jest.fn(settingLookup) },
    catalogService: {
      findMany: jest.fn().mockResolvedValue(catalogRows(catalog)),
    },
    providerProfile: {
      findUnique: jest.fn().mockResolvedValue(options.live ?? null),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const audit = { record: jest.fn() };
  const names = new Map([
    ['city-1', { id: 'city-1', name: 'Ikeja', stateName: 'Lagos' }],
    ['district-1', { id: 'district-1', name: 'Alausa', stateName: 'Lagos' }],
  ]);
  const locations = {
    validateProviderLocations: jest.fn().mockResolvedValue({
      locationId: 'city-1',
      serviceAreaIds: ['district-1'],
    }),
    summaries: jest.fn().mockResolvedValue(names),
    outsideServedAreasFor: jest.fn((lists: string[][]) =>
      Promise.resolve(lists.map(() => options.outsideServed ?? false)),
    ),
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
    emailVerifiedAt: options.emailVerified === false ? null : new Date(),
    phoneE164: '+2348031234567',
    phoneVerifiedAt: new Date(),
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
  return { service, prisma, tx, catalog, locations };
}

describe('ProvidersService', () => {
  it('rejects a profile whose phone differs from the verified account number', async () => {
    const { service, prisma } = setup({ requirePhoneVerification: true });
    await expect(
      service.submit('user-1', submission({ phone: '08031234568' })),
    ).rejects.toThrow(
      'Verify your phone number before submitting your profile.',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks verification under the account lock before saving', async () => {
    const { service, tx } = setup({ requirePhoneVerification: true });
    tx.user.findUnique.mockResolvedValueOnce({
      emailVerifiedAt: new Date(),
      phoneE164: '+2348031234567',
      phoneVerifiedAt: null,
    });
    await expect(
      service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': [INTERIOR] },
        }),
      ),
    ).rejects.toThrow(
      'Verify your phone number before submitting your profile.',
    );
    expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
  });

  it('allows an unverified number by default and clears verification when the phone changes', async () => {
    const { service, tx } = setup();
    await service.submit(
      'user-1',
      submission({
        phone: '08031234568',
        serviceIds: ['svc:Design'],
        skillIds: { 'svc:Design': [INTERIOR] },
      }),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { phoneE164: '+2348031234568', phoneVerifiedAt: null },
    });
    expect(tx.phoneVerification.updateMany).toHaveBeenCalled();
    expect(tx.providerProfile.upsert).toHaveBeenCalled();
  });

  it('enforces a requirement enabled after the initial policy read', async () => {
    const { service, tx } = setup();
    tx.setting.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.key === 'provider.requirePhoneVerification'
          ? { value: true }
          : null,
      ),
    );
    tx.user.findUnique.mockResolvedValue({
      emailVerifiedAt: new Date(),
      phoneE164: '+2348031234567',
      phoneVerifiedAt: null,
    });
    await expect(
      service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': [INTERIOR] },
        }),
      ),
    ).rejects.toThrow('Verify your phone number');
    expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
  });

  it('exposes only the onboarding verification policy to providers', async () => {
    const disabled = setup({ requireEmailVerification: false });
    await expect(disabled.service.onboardingPolicy('user-1')).resolves.toEqual({
      phoneVerificationRequired: false,
      emailVerificationRequired: false,
    });
    const enabled = setup({ requirePhoneVerification: true });
    await expect(enabled.service.onboardingPolicy('user-1')).resolves.toEqual({
      phoneVerificationRequired: true,
      emailVerificationRequired: true,
    });
  });

  const emailSubmission = () =>
    submission({
      serviceIds: ['svc:Design'],
      skillIds: { 'svc:Design': [INTERIOR] },
    });

  it('requires a verified email by default', async () => {
    const { service, prisma } = setup({ emailVerified: false });
    await expect(service.submit('user-1', emailSubmission())).rejects.toThrow(
      'Verify your email before submitting your provider profile.',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts an unverified email when the requirement is turned off', async () => {
    const { service, tx } = setup({
      emailVerified: false,
      requireEmailVerification: false,
    });
    await service.submit('user-1', emailSubmission());
    expect(tx.providerProfile.upsert).toHaveBeenCalled();
  });

  it('enforces an email requirement re-enabled after the initial policy read', async () => {
    const { service, tx } = setup({
      emailVerified: false,
      requireEmailVerification: false,
    });
    tx.setting.findUnique.mockResolvedValue({ value: true });
    await expect(service.submit('user-1', emailSubmission())).rejects.toThrow(
      'Verify your email before submitting your provider profile.',
    );
    expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
  });
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
          serviceIds: ['svc:Hiring', 'svc:Design', 'svc:Hiring'],
          skillIds: {
            'svc:Hiring': [EXCAVATOR, MASON, EXCAVATOR],
            'svc:Design': [INTERIOR],
          },
        }),
      );
      const data = created(tx);
      expect(data.serviceIds).toEqual(['svc:Hiring', 'svc:Design']);
      expect(data.skillIds).toEqual({
        'svc:Hiring': [EXCAVATOR, MASON],
        'svc:Design': [INTERIOR],
      });
      expect(data.services).toEqual(['Hiring', 'Design']);
      expect(data.skills).toEqual({
        Hiring: ['Excavator', 'Mason'],
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
          skillIds: { 'svc:Design': [INTERIOR], 'svc:Hiring': [EXCAVATOR] },
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
        { serviceIds: ['svc:Hiring/Professional'], skillIds: {} },
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
        'svc:Hiring/Heavy equipment',
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
            serviceIds: ['svc:Hiring'],
            skillIds: { 'svc:Hiring': [EXCAVATOR] },
          }),
        ),
      ).rejects.toThrow('Choose Hiring skills from the list.');
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

  describe('submit locations', () => {
    it('stores only the validated ids', async () => {
      const { service, tx, locations } = setup();
      await service.submit(
        'user-1',
        submission({
          locationId: 'city-1',
          serviceIds: ['svc:Design'],
          skillIds: { 'svc:Design': [INTERIOR] },
        }),
      );
      expect(locations.validateProviderLocations).toHaveBeenCalledWith(
        expect.objectContaining({
          locationId: 'city-1',
          serviceAreaIds: ['district-1'],
        }),
      );
      const data = created(tx);
      expect(data).toMatchObject({
        locationId: 'city-1',
        serviceAreaIds: ['district-1'],
      });
      expect(data).not.toHaveProperty('city');
      expect(data).not.toHaveProperty('state');
      expect(data).not.toHaveProperty('serviceAreas');
    });

    it('refuses a profile without service areas before looking at anything else', async () => {
      const { service, locations } = setup();
      await expect(
        service.submit(
          'user-1',
          submission({
            serviceAreaIds: [],
            serviceIds: ['svc:Design'],
            skillIds: { 'svc:Design': [INTERIOR] },
          }),
        ),
      ).rejects.toThrow('Add at least one service area.');
      expect(locations.validateProviderLocations).not.toHaveBeenCalled();
    });

    it('lets the location check refuse an unknown LGA', async () => {
      const { service, tx, locations } = setup();
      locations.validateProviderLocations.mockRejectedValueOnce(
        new BadRequestException('Choose your state and LGA from the list.'),
      );
      await expect(
        service.submit(
          'user-1',
          submission({
            serviceIds: ['svc:Design'],
            skillIds: { 'svc:Design': [INTERIOR] },
          }),
        ),
      ).rejects.toThrow('Choose your state and LGA from the list.');
      expect(tx.providerProfile.upsert).not.toHaveBeenCalled();
    });
  });

  describe('submit by legacy names', () => {
    it('converts names to ids and keeps the names as the snapshot', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          services: ['Hiring', 'Design'],
          skills: { Hiring: ['Excavator'], Design: ['Interior design'] },
        }),
      );
      const data = created(tx);
      expect(data.serviceIds).toEqual(['svc:Hiring', 'svc:Design']);
      expect(data.skillIds).toEqual({
        'svc:Hiring': [EXCAVATOR],
        'svc:Design': [INTERIOR],
      });
      expect(data.services).toEqual(['Hiring', 'Design']);
    });

    it('prefers ids when both are sent', async () => {
      const { service, tx } = setup();
      await service.submit(
        'user-1',
        submission({
          services: ['Hiring'],
          skills: { Hiring: ['Excavator'] },
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
        { services: ['Hiring'], skills: { Hiring: ['Wizard'] } },
        'Choose Hiring skills from the list.',
      ],
      [
        'a skill that belongs to another service',
        { services: ['Design'], skills: { Design: ['Excavator'] } },
        'Choose Design skills from the list.',
      ],
      [
        'no skills for a service that has skills',
        { services: ['Hiring'], skills: {} },
        'Choose at least one skill for Hiring.',
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

    it('applies service areas immediately and holds the other reviewed fields', async () => {
      const { service, tx } = setup({ live });
      await service.submit(
        'user-1',
        submission({
          serviceIds: ['svc:Hiring'],
          skillIds: { 'svc:Hiring': [EXCAVATOR] },
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
        serviceIds: ['svc:Hiring'],
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        services: ['Hiring'],
        skills: { Hiring: ['Excavator'] },
      });
      expect(data.pendingChanges).toMatchObject({
        locationId: 'city-1',
      });
      expect(data.serviceAreaIds).toEqual(['district-1']);
      expect(data.pendingChanges).not.toHaveProperty('serviceAreaIds');
      expect(
        tx.providerReview.create.mock.calls[0][0].data.fields,
      ).not.toContain('Service areas');
      expect(data.pendingChanges).not.toHaveProperty('serviceAreas');
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
          locationId: 'lga-1',
          serviceAreaIds: ['district-1'],
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
        services: ['Hiring'],
        serviceIds: ['svc:Hiring'],
        skills: { Hiring: ['Excavator'] },
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
      });
      expect(data.serviceIds).toEqual(['svc:Hiring']);
      expect(data.skillIds).toEqual({ 'svc:Hiring': [EXCAVATOR] });
      expect(data.services).toEqual(['Hiring']);
      expect(data.pendingChanges).toBe(Prisma.DbNull);
    });

    it('applies the held location and service area ids', async () => {
      const data = await reviewer({
        services: ['Hiring'],
        locationId: 'lga-1',
        serviceAreaIds: ['district-1', 'lga-1'],
      });
      expect(data.locationId).toBe('lga-1');
      expect(data.serviceAreaIds).toEqual(['district-1', 'lga-1']);
      expect(data).not.toHaveProperty('serviceAreas');
      expect(data).not.toHaveProperty('city');
    });

    it('falls back to a legacy cityId when it is an LGA', async () => {
      const data = await reviewer({ cityId: 'lga-1', city: 'Old name' });
      expect(data.locationId).toBe('lga-1');
      expect(data).not.toHaveProperty('city');
    });

    it('ignores a legacy cityId that is not an LGA (the old Abuja city is now a state)', async () => {
      const data = await reviewer({
        locationId: undefined,
        cityId: 'state-fct',
        state: 'FCT',
      });
      expect(data).not.toHaveProperty('locationId');
      expect(data).not.toHaveProperty('state');
    });

    it('clears the live ids when the change predates them, so readers use its names', async () => {
      const data = await reviewer({
        services: ['Hiring'],
        skills: { Hiring: ['Excavator'] },
      });
      expect(data.serviceIds).toBe(Prisma.DbNull);
      expect(data.skillIds).toBe(Prisma.DbNull);
    });
  });

  describe('myProfile', () => {
    it('returns the current names for stored ids, so a rename shows at once', async () => {
      const catalog = seededCatalog();
      catalog.byId.get(
        'svc:Hiring/Heavy equipment',
      )!.questions[0].options[0].label = 'Excavator (20t)';
      catalog.byId.get('svc:Hiring')!.name = 'Hire and rental';
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        locationId: 'city-1',
        serviceAreaIds: ['district-1'],
        services: ['Hiring'],
        serviceIds: ['svc:Hiring'],
        skills: { Hiring: ['Excavator'] },
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        pendingChanges: {
          trade: 'Builder',
          submittedAt: 'earlier',
          services: ['Hiring'],
          serviceIds: ['svc:Hiring'],
          skills: { Hiring: ['Excavator', 'Mason'] },
          skillIds: { 'svc:Hiring': [EXCAVATOR, MASON] },
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
        serviceIds: ['svc:Hiring'],
        skills: { 'Hire and rental': ['Excavator (20t)'] },
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        pendingChanges: {
          submittedAt: 'earlier',
          services: ['Hire and rental'],
          skills: { 'Hire and rental': ['Excavator (20t)', 'Mason'] },
          skillIds: { 'svc:Hiring': [EXCAVATOR, MASON] },
        },
      });
    });

    it('returns ids plus read-only names for the location and service areas', async () => {
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        locationId: 'city-1',
        serviceAreaIds: ['district-1', 'gone', 'city-1'],
        services: ['Hiring'],
        serviceIds: ['svc:Hiring'],
        skills: { Hiring: ['Excavator'] },
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        pendingChanges: {
          trade: 'Builder',
          locationId: 'city-1',
          serviceAreaIds: ['city-1'],
        },
        bankAccounts: [],
        reviews: [],
      };
      const { service, locations } = setup({
        live: row,
        stubProfile: false,
        outsideServed: true,
      });
      const profile = (await service.myProfile('user-1')) as unknown as Record<
        string,
        unknown
      >;
      expect(profile).toMatchObject({
        locationId: 'city-1',
        state: 'Lagos',
        city: 'Ikeja',
        serviceAreaIds: ['district-1', 'gone', 'city-1'],
        serviceAreas: ['Alausa', 'Ikeja'],
        outsideServedAreas: true,
        pendingChanges: { serviceAreas: ['Ikeja'] },
      });
      expect(profile).not.toHaveProperty('cityId');
      expect(locations.summaries).toHaveBeenCalledTimes(1);
    });

    it('does not flag a profile with no service areas as outside the served areas', async () => {
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        locationId: null,
        serviceAreaIds: [],
        services: [],
        serviceIds: null,
        skills: {},
        skillIds: null,
        pendingChanges: null,
        bankAccounts: [],
        reviews: [],
      };
      const { service } = setup({
        live: row,
        stubProfile: false,
        outsideServed: true,
      });
      await expect(service.myProfile('user-1')).resolves.toMatchObject({
        locationId: null,
        city: '',
        state: null,
        serviceAreas: [],
        outsideServedAreas: false,
      });
    });

    it('resolves a not-yet-backfilled profile from its names', async () => {
      const row = {
        id: 'profile-1',
        userId: 'user-1',
        locationId: 'city-1',
        serviceAreaIds: ['district-1'],
        services: ['Hiring'],
        serviceIds: null,
        skills: { Hiring: ['Excavator'] },
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
        serviceIds: ['svc:Hiring'],
        skillIds: { 'svc:Hiring': [EXCAVATOR] },
        services: ['Hiring'],
        skills: { Hiring: ['Excavator'] },
      });
    });
  });
});
