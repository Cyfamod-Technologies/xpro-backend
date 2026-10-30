import { LocationsService } from './locations.service';

const ABUJA = '00000000-0000-4000-8000-000000000001';
const WUSE = '00000000-0000-4000-8000-000000000004';

function setup() {
  const rows = [
    {
      id: ABUJA,
      kind: 'city',
      name: 'Abuja (FCT)',
      parentId: null,
      aliases: ['Abuja'],
      active: true,
      sort: 0,
    },
    {
      id: WUSE,
      kind: 'district',
      name: 'Wuse',
      parentId: ABUJA,
      aliases: [],
      active: true,
      sort: 1,
    },
  ];
  const prisma = { location: { findMany: jest.fn().mockResolvedValue(rows) } };
  return new LocationsService(prisma as never, {} as never, {} as never);
}

describe('LocationsService.resolveProviderLocationIds', () => {
  it('keeps the id of a managed city and district so dispatch can match them', async () => {
    await expect(
      setup().resolveProviderLocationIds({
        state: 'FCT',
        city: 'Abuja',
        serviceAreas: ['Wuse'],
      }),
    ).resolves.toEqual({
      cityId: ABUJA,
      state: 'FCT',
      cityName: 'Abuja (FCT)',
      serviceAreaIds: [WUSE],
      serviceAreaNames: ['Wuse'],
    });
  });

  it('accepts a built-in state and city that no admin created', async () => {
    await expect(
      setup().resolveProviderLocationIds({
        state: 'lagos',
        city: 'Ajeromi-Ifelodun',
        serviceAreas: ['Ikeja', 'Wuse'],
      }),
    ).resolves.toEqual({
      cityId: undefined,
      state: 'Lagos',
      cityName: 'Ajeromi-Ifelodun',
      serviceAreaIds: [WUSE],
      serviceAreaNames: ['Ikeja', 'Wuse'],
    });
  });

  it('rejects a city that is not in the chosen state, or sent without a state', async () => {
    const message = 'Choose your state and city from the list.';
    await expect(
      setup().resolveProviderLocationIds({
        state: 'Kano',
        city: 'Ajeromi-Ifelodun',
        serviceAreas: ['Ikeja'],
      }),
    ).rejects.toThrow(message);
    await expect(
      setup().resolveProviderLocationIds({
        city: 'Ajeromi-Ifelodun',
        serviceAreas: ['Ikeja'],
      }),
    ).rejects.toThrow(message);
  });

  it('rejects an unknown service area and requires at least one', async () => {
    await expect(
      setup().resolveProviderLocationIds({
        state: 'Lagos',
        city: 'Ikeja',
        serviceAreas: ['Nowhere'],
      }),
    ).rejects.toThrow('Choose service areas from the location list.');
    await expect(
      setup().resolveProviderLocationIds({
        state: 'Lagos',
        city: 'Ikeja',
        serviceAreas: [],
      }),
    ).rejects.toThrow('Add at least one service area.');
  });
});
