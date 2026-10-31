import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { ProviderDispatchLoader } from '../../requests/dispatch/provider-dispatch.loader';
import { dispatchRequestFor } from '../../requests/domain/dispatch-request';
import { evaluateEligibility } from '../../requests/domain/eligibility';
import { validateIntake } from '../../requests/domain/intake-validation';
import { resolveServiceInput } from '../../requests/domain/legacy-service-input';
import { CatalogService } from './catalog.service';
import { loadCatalog } from './catalog.tree';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seeded service catalog (integration)', () => {
  it('has the five website roots, six Construction groups of six leaves and no active Procurement', async () => {
    const catalog = await loadCatalog(prisma);
    const active = catalog.roots.filter(({ active: on }) => on);
    expect(active.map(({ name }) => name)).toEqual([
      'Design',
      'Construction',
      'Hiring',
      'Facility Management',
      'Waste Management',
    ]);
    expect(
      catalog.roots.filter(
        ({ name, active: on }) => name === 'Procurement' && on,
      ),
    ).toEqual([]);

    const construction = active[1];
    const groups = construction.children.filter(({ active: on }) => on);
    expect(groups.map(({ name }) => name)).toEqual([
      'Floor Finishing',
      'Wall Finishing',
      'Ceiling Finishing',
      'Roof Finishing',
      'Final Finishing',
      'Facade Finishing',
    ]);
    for (const group of groups) {
      expect(group.children).toHaveLength(6);
      expect(group.children.every(({ depth }) => depth === 2)).toBe(true);
    }
    expect(groups[0].children.map(({ name }) => name)).toEqual([
      'Tiling',
      'Concrete Paving/Interlocking',
      'Wood Floor Covering & Epoxy',
      'Asphalt Covering',
      'Gabion Flooring',
      'Skirting Installation',
    ]);
  });

  it('turns the Hiring trades into 19, 20 and 19 leaves and asks no skill question', async () => {
    const catalog = await loadCatalog(prisma);
    const hiring = catalog.roots.find(({ name }) => name === 'Hiring')!;
    expect(hiring.requiresStartDate).toBe(true);
    expect(hiring.children.map(({ name }) => name)).toEqual([
      'Professionals',
      'Vocational Workers',
      'Heavy Equipment',
    ]);
    expect(
      hiring.children.map(
        ({ children }) => children.filter(({ active }) => active).length,
      ),
    ).toEqual([19, 20, 19]);
    expect(hiring.questions.map(({ key }) => key)).toEqual([
      'quantity',
      'endDate',
    ]);
    const heavy = hiring.children[2];
    expect(heavy.children.some(({ name }) => name === 'Tipper truck')).toBe(
      false,
    );
    expect(
      heavy.questions.filter(({ active }) => active).map(({ key }) => key),
    ).toEqual(['operator']);
    expect(
      await prisma.serviceQuestion.count({
        where: { active: true, matchesSkill: true },
      }),
    ).toBe(0);
  });

  it('keeps Facility Management and Waste Management in the new order', async () => {
    const catalog = await loadCatalog(prisma);
    const names = (root: string) =>
      catalog.roots
        .find(({ name }) => name === root)!
        .children.filter(({ active }) => active)
        .map(({ name }) => name);
    expect(names('Facility Management')).toEqual([
      'Cleaning & Janitorial',
      'Building Maintenance & Repairs',
      'Security Services',
      'Landscaping & Grounds Keeping',
      'Pest Control',
      'HVAC Servicing & Maintenance',
      'Property/Facility Management',
      'Facility Inspections & Reporting',
    ]);
    expect(names('Waste Management')).toEqual([
      'Residential',
      'Commercial',
      'Construction debris',
    ]);
    expect(names('Design')).toEqual([
      'Architectural Designs',
      'Interior Designs',
      'Structural Designs',
    ]);
  });

  it('accepts legacy-shaped Construction and Hire input against the database catalog', async () => {
    const catalog = await loadCatalog(prisma);
    const base = {
      title: 'Repair a leaking roof',
      cityId: 'city',
      districtId: 'district',
      address: '12 Broad Street, Lagos',
      phone: '08031234567',
      description:
        'Water enters through two areas of the roof whenever it rains.',
      budget: 0,
    };
    const locations = [
      { id: 'city', kind: 'city', parentId: null, active: true },
      { id: 'district', kind: 'district', parentId: 'city', active: true },
    ];
    const run = (input: Record<string, unknown>) =>
      validateIntake(
        input,
        resolveServiceInput(catalog, input),
        locations,
        new Date('2026-10-23T12:00:00Z'),
      );
    expect(
      run({
        ...base,
        service: 'Construction',
        details: { workType: 'Tiling', area: 42 },
      }),
    ).toMatchObject({ skill: 'Tiling', details: { area: 42 } });
    expect(
      run({
        ...base,
        service: 'Hire',
        startDate: '2026-10-25',
        details: { trade: 'Crane', quantity: 1, endDate: '2026-10-30' },
      }),
    ).toMatchObject({ skill: 'Crane', effectiveEndDate: '2026-10-30' });
  });
});

describe('provider skills by id (integration)', () => {
  const districtId = randomUUID();
  const cityId = randomUUID();
  let leafId = '';

  afterAll(async () => {
    await deleteTestUsers(prisma);
    if (leafId)
      await prisma.catalogService.update({
        where: { id: leafId },
        data: { name: 'Excavator' },
      });
  });

  it('keeps a provider eligible after the skill leaf is renamed, with no name rewrite', async () => {
    const catalog = await loadCatalog(prisma);
    const hiring = catalog.roots.find(({ name }) => name === 'Hiring')!;
    const heavy = hiring.children.find(
      ({ name }) => name === 'Heavy Equipment',
    )!;
    const excavator = heavy.children.find(({ name }) => name === 'Excavator')!;
    leafId = excavator.id;

    const owner = await createUser(prisma);
    const user = await createUser(prisma);
    const everyDay = { start: '00:00', end: '23:59' };
    const profile = await prisma.providerProfile.create({
      data: {
        userId: user.id,
        phone: '+2348000000000',
        trade: 'Operator',
        city: 'Test city',
        // The names match nothing, so only the ids can make this provider eligible.
        services: ['Legacy name'],
        skills: { 'Legacy name': ['Legacy skill'] },
        serviceIds: [hiring.id],
        skillIds: { [hiring.id]: [leafId] },
        serviceAreas: [],
        serviceAreaIds: [districtId],
        workingHours: { mon: everyDay },
        bio: 'Integration test provider.',
        verification: 'approved',
        available: true,
      },
    });

    const catalogService = new CatalogService(
      prisma as never,
      {
        resolve: () =>
          Promise.resolve({
            userId: owner.id,
            kind: 'staff',
            displayName: 'Catalog manager',
            platformRoles: [],
            accountActive: true,
            staff: {
              status: 'active',
              roles: [],
              permissions: new Set(['catalog.manage']),
              canOwn: false,
              isSuperAdmin: false,
              permVersion: 1,
            },
          }),
      } as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    await catalogService.updateService(owner.id, leafId, {
      version: excavator.version,
      name: 'Excavator (20t)',
    });

    const renamed = await loadCatalog(prisma);
    expect(renamed.byId.get(leafId)!.name).toBe('Excavator (20t)');

    const loader = new ProviderDispatchLoader(prisma as never);
    const provider = await loader.one(
      profile.id,
      new Date(),
      randomUUID(),
      prisma,
    );
    expect(provider).toMatchObject({
      serviceIds: [hiring.id],
      skillIds: { [hiring.id]: [leafId] },
    });

    const request = await dispatchRequestFor(
      prisma,
      {
        id: randomUUID(),
        ownerId: owner.id,
        service: 'Hiring',
        serviceId: leafId,
        districtId,
        cityId,
        startDate: null,
        details: {},
        answers: [],
      },
      { districtName: 'Test district' },
    );
    expect(request).toMatchObject({
      serviceId: hiring.id,
      skill: 'Excavator (20t)',
      skillId: leafId,
    });
    expect(
      evaluateEligibility(provider!, request, { requireVerifiedBank: false }),
    ).toEqual({ eligible: true });
  });
});
