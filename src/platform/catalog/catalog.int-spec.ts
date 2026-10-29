import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { ProviderDispatchLoader } from '../../requests/dispatch/provider-dispatch.loader';
import { dispatchRequestFor } from '../../requests/domain/dispatch-request';
import { evaluateEligibility } from '../../requests/domain/eligibility';
import { validateIntake } from '../../requests/domain/intake-validation';
import { resolveServiceInput } from '../../requests/domain/legacy-service-input';
import { CatalogQuestionService } from './catalog-question.service';
import { CatalogService } from './catalog.service';
import { loadCatalog } from './catalog.tree';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seeded service catalog (integration)', () => {
  it('seeds the six roots, their sub-services and the Hire skill questions', async () => {
    const catalog = await loadCatalog(prisma);
    expect(catalog.roots.map(({ name }) => name)).toEqual([
      'Design',
      'Construction',
      'Hire',
      'Procurement',
      'Facility management',
      'Waste management',
    ]);
    const hire = catalog.roots[2];
    expect(hire.requiresStartDate).toBe(true);
    expect(hire.children.map(({ name }) => name)).toEqual([
      'Professional',
      'Vocational worker',
      'Heavy equipment',
    ]);
    const trades = hire.children.flatMap(({ questions }) =>
      questions.filter(({ key }) => key === 'trade'),
    );
    expect(trades.map(({ label }) => label)).toEqual([
      'Professional required',
      'Trade required',
      'Equipment required',
    ]);
    expect(trades.flatMap(({ options }) => options)).toHaveLength(22);
    expect(catalog.byId.size).toBe(33);
  });

  it('accepts a legacy Construction request and a Hire request against the database catalog', async () => {
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
        details: { workType: 'Roof and ceiling', area: 42 },
      }),
    ).toMatchObject({ skill: 'Roof and ceiling', details: { area: 42 } });
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
  let optionId = '';
  let questionId = '';

  afterAll(async () => {
    await deleteTestUsers(prisma);
    if (questionId) {
      const question = await prisma.serviceQuestion.findUniqueOrThrow({
        where: { id: questionId },
      });
      const options = (question.options as Array<{ id: string }>).map(
        (option) =>
          option.id === optionId ? { ...option, label: 'Excavator' } : option,
      );
      await prisma.serviceQuestion.update({
        where: { id: questionId },
        data: { options },
      });
    }
  });

  it('keeps a provider eligible after the skill option is renamed, with no name rewrite', async () => {
    const catalog = await loadCatalog(prisma);
    const hire = catalog.roots.find(({ name }) => name === 'Hire')!;
    const heavy = hire.children.find(({ name }) => name === 'Heavy equipment')!;
    const question = heavy.questions.find(({ matchesSkill }) => matchesSkill)!;
    const excavator = question.options.find(
      ({ label }) => label === 'Excavator',
    )!;
    optionId = excavator.id;
    questionId = question.id;

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
        serviceIds: [hire.id],
        skillIds: { [hire.id]: [optionId] },
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
    const questions = new CatalogQuestionService(
      prisma as never,
      catalogService,
    );
    await questions.update(owner.id, question.id, {
      version: question.version,
      options: question.options.map((option) =>
        option.id === optionId
          ? { ...option, label: 'Excavator (20t)' }
          : option,
      ),
    });

    const renamed = await loadCatalog(prisma);
    expect(
      renamed.byId
        .get(heavy.id)!
        .questions.find(({ id }) => id === question.id)!
        .options.find(({ id }) => id === optionId)!.label,
    ).toBe('Excavator (20t)');

    const loader = new ProviderDispatchLoader(prisma as never);
    const provider = await loader.one(
      profile.id,
      new Date(),
      randomUUID(),
      prisma,
    );
    expect(provider).toMatchObject({
      serviceIds: [hire.id],
      skillIds: { [hire.id]: [optionId] },
    });

    const request = await dispatchRequestFor(
      prisma,
      {
        id: randomUUID(),
        ownerId: owner.id,
        service: 'Hire',
        serviceId: heavy.id,
        districtId,
        cityId,
        startDate: null,
        details: {},
        answers: [
          {
            questionId: question.id,
            serviceId: heavy.id,
            serviceName: heavy.name,
            key: question.key,
            label: question.label,
            type: 'single_choice',
            value: 'Excavator',
            display: 'Excavator',
            optionIds: [optionId],
            sensitive: false,
            matchesSkill: true,
          },
        ],
      },
      { districtName: 'Test district' },
    );
    expect(request).toMatchObject({
      serviceId: hire.id,
      skill: 'Excavator (20t)',
      skillId: optionId,
    });
    expect(
      evaluateEligibility(provider!, request, { requireVerifiedBank: false }),
    ).toEqual({ eligible: true });
  });
});
