import { LocationsService } from './locations.service';
import type { SaveLocationDto } from './locations.dto';

type Row = {
  id: string;
  kind: 'state' | 'lga' | 'area';
  name: string;
  parentId: string | null;
  ancestorIds: string[];
  aliases: string[];
  active: boolean;
  serviceable: boolean;
  sort: number;
};

const FCT = 'state-fct';
const LAGOS = 'state-lagos';
const AMAC = 'lga-amac';
const BWARI = 'lga-bwari';
const IKEJA = 'lga-ikeja';
const WUSE = 'area-wuse';
const KUBWA = 'area-kubwa';

const row = (
  id: string,
  kind: Row['kind'],
  parentId: string | null,
  ancestorIds: string[],
  extra: Partial<Row> = {},
): Row => ({
  id,
  kind,
  name: id,
  parentId,
  ancestorIds,
  aliases: [],
  active: true,
  serviceable: false,
  sort: 0,
  ...extra,
});

function rows(): Row[] {
  return [
    row(FCT, 'state', null, [], { serviceable: true }),
    row(LAGOS, 'state', null, []),
    row(AMAC, 'lga', FCT, [FCT], { serviceable: true }),
    row(BWARI, 'lga', FCT, [FCT], { serviceable: true }),
    row(IKEJA, 'lga', LAGOS, [LAGOS]),
    row(WUSE, 'area', AMAC, [FCT, AMAC], { serviceable: true }),
    row(KUBWA, 'area', BWARI, [FCT, BWARI], { serviceable: true }),
  ];
}

/** An in-memory `locations` table that understands just the filters the service uses. */
function setup(initial: Row[] = rows()) {
  const table = initial;
  const matches = (item: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'AND')
        return (value as Record<string, unknown>[]).every((w) =>
          matches(item, w),
        );
      if (key === 'OR')
        return (value as Record<string, unknown>[]).some((w) =>
          matches(item, w),
        );
      if (key === 'id' || key === 'parentId') {
        const v = value as string | null | { in: string[] };
        return v !== null && typeof v === 'object'
          ? v.in.includes(item[key] as string)
          : item[key] === v;
      }
      if (key === 'ancestorIds')
        return (value as { hasSome: string[] }).hasSome.some((id) =>
          item.ancestorIds.includes(id),
        );
      if (key === 'parent') {
        const parent = table.find(({ id }) => id === item.parentId);
        return (
          Boolean(parent) && matches(parent!, value as Record<string, unknown>)
        );
      }
      return (item as Record<string, unknown>)[key] === value;
    });
  const location = {
    findMany: jest.fn(
      ({
        where,
        select,
      }: {
        where?: Record<string, unknown>;
        select?: {
          _count?: { select: { children: { where: Record<string, unknown> } } };
        };
      }) =>
        Promise.resolve(
          table
            .filter((item) => matches(item, where))
            .map((item) =>
              select?._count
                ? {
                    ...item,
                    _count: {
                      children: table.filter(
                        (child) =>
                          child.parentId === item.id &&
                          matches(child, select._count!.select.children.where),
                      ).length,
                    },
                  }
                : item,
            ),
        ),
    ),
    findFirst: jest.fn(({ where }: { where?: Record<string, unknown> }) =>
      Promise.resolve(table.find((item) => matches(item, where)) ?? null),
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        (() => {
          const found = table.find(({ id }) => id === where.id);
          return found ? { ...found } : null;
        })(),
      ),
    ),
    count: jest.fn(({ where }: { where?: Record<string, unknown> }) =>
      Promise.resolve(table.filter((item) => matches(item, where)).length),
    ),
    create: jest.fn(({ data }: { data: Omit<Row, 'id'> }) => {
      const created = { id: `new-${table.length}`, ...data };
      table.push(created);
      return Promise.resolve(created);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const found = table.find(({ id }) => id === where.id);
        if (!found) return Promise.reject(new Error('missing'));
        Object.assign(found, data);
        return Promise.resolve(found);
      },
    ),
  };
  const prisma = {
    location,
    $transaction: (fn: (tx: unknown) => unknown) => fn({ location }),
  };
  const audit = { record: jest.fn() };
  const actors = {
    resolve: jest.fn().mockResolvedValue({
      staff: { status: 'active', permissions: new Set(['settings.manage']) },
    }),
  };
  const service = new LocationsService(
    prisma as never,
    actors as never,
    audit as never,
  );
  return { service, table, audit, location };
}

describe('LocationsService.validateProviderLocations', () => {
  it('accepts an active LGA and de-duplicates the service areas', async () => {
    await expect(
      setup().service.validateProviderLocations({
        locationId: AMAC,
        serviceAreaIds: [WUSE, FCT, WUSE],
      }),
    ).resolves.toEqual({ locationId: AMAC, serviceAreaIds: [WUSE, FCT] });
  });

  it('covers places that are not served yet', async () => {
    await expect(
      setup().service.validateProviderLocations({
        locationId: IKEJA,
        serviceAreaIds: [LAGOS],
      }),
    ).resolves.toEqual({ locationId: IKEJA, serviceAreaIds: [LAGOS] });
  });

  it('rejects a missing, inactive or non-LGA home location', async () => {
    const message = 'Choose your state and LGA from the list.';
    const { service, table } = setup();
    await expect(
      service.validateProviderLocations({ serviceAreaIds: [WUSE] }),
    ).rejects.toThrow(message);
    await expect(
      service.validateProviderLocations({
        locationId: FCT,
        serviceAreaIds: [WUSE],
      }),
    ).rejects.toThrow(message);
    await expect(
      service.validateProviderLocations({
        locationId: WUSE,
        serviceAreaIds: [WUSE],
      }),
    ).rejects.toThrow(message);
    await expect(
      service.validateProviderLocations({
        locationId: 'nowhere',
        serviceAreaIds: [WUSE],
      }),
    ).rejects.toThrow(message);
    table.find(({ id }) => id === AMAC)!.active = false;
    await expect(
      service.validateProviderLocations({
        locationId: AMAC,
        serviceAreaIds: [WUSE],
      }),
    ).rejects.toThrow(message);
  });

  it('rejects an unknown or inactive service area and requires at least one', async () => {
    const { service, table } = setup();
    await expect(
      service.validateProviderLocations({
        locationId: AMAC,
        serviceAreaIds: ['nowhere'],
      }),
    ).rejects.toThrow('Choose service areas from the location list.');
    table.find(({ id }) => id === WUSE)!.active = false;
    await expect(
      service.validateProviderLocations({
        locationId: AMAC,
        serviceAreaIds: [WUSE],
      }),
    ).rejects.toThrow('Choose service areas from the location list.');
    await expect(
      service.validateProviderLocations({
        locationId: AMAC,
        serviceAreaIds: [],
      }),
    ).rejects.toThrow('Add at least one service area.');
  });
});

describe('LocationsService.outsideServedAreas', () => {
  it('is false when an area is a served place or sits under one', async () => {
    const { service } = setup();
    await expect(service.outsideServedAreas([WUSE])).resolves.toBe(false);
    await expect(service.outsideServedAreas([FCT])).resolves.toBe(false);
    await expect(service.outsideServedAreas([LAGOS, BWARI])).resolves.toBe(
      false,
    );
  });

  it('is true when nothing the provider covers reaches a served place', async () => {
    const { service } = setup();
    await expect(service.outsideServedAreas([LAGOS])).resolves.toBe(true);
    await expect(service.outsideServedAreas([IKEJA])).resolves.toBe(true);
    await expect(service.outsideServedAreas([])).resolves.toBe(true);
  });

  it('does not count a place under an unserved ancestor', async () => {
    const { service, table } = setup();
    table.find(({ id }) => id === FCT)!.serviceable = false;
    await expect(service.outsideServedAreas([WUSE])).resolves.toBe(true);
  });

  it('answers a page of coverage lists with one query', async () => {
    const { service, location } = setup();
    await expect(
      service.outsideServedAreasFor([[LAGOS], [KUBWA], [IKEJA, FCT]]),
    ).resolves.toEqual([true, false, false]);
    expect(location.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('LocationsService.list', () => {
  it('returns served places with hasChildren counted under the same filters', async () => {
    const { service, table } = setup();
    table.find(({ id }) => id === KUBWA)!.serviceable = false;
    const states = await service.list(undefined, { serviceable: true });
    expect(states.map(({ id }) => id)).toEqual([FCT]);
    const lgas = await service.list(FCT, { serviceable: true });
    expect(lgas.map(({ id, hasChildren }) => [id, hasChildren])).toEqual([
      [AMAC, true],
      [BWARI, false],
    ]);
    const all = await service.list(FCT);
    expect(all.map(({ id, hasChildren }) => [id, hasChildren])).toEqual([
      [AMAC, true],
      [BWARI, true],
    ]);
  });

  it('hides places under an inactive ancestor', async () => {
    const { service, table } = setup();
    table.find(({ id }) => id === AMAC)!.active = false;
    await expect(service.list(AMAC)).resolves.toEqual([]);
  });
});

describe('LocationsService.save', () => {
  const dto = (extra: Partial<SaveLocationDto>): SaveLocationDto => ({
    kind: 'area',
    name: 'Gwarinpa',
    parentId: AMAC,
    aliases: [],
    active: true,
    serviceable: true,
    sort: 1,
    ...extra,
  });

  it('creates an area under an LGA with its ancestors and records serviceable', async () => {
    const { service, audit } = setup();
    const created = await service.save('staff', undefined, dto({}));
    expect(created).toMatchObject({
      kind: 'area',
      parentId: AMAC,
      ancestorIds: [FCT, AMAC],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          kind: 'area',
          name: 'Gwarinpa',
          active: true,
          serviceable: true,
        },
      }),
    );
  });

  it('enforces the parent rules', async () => {
    const { service } = setup();
    await expect(
      service.save('staff', undefined, dto({ kind: 'state', parentId: FCT })),
    ).rejects.toThrow('A state cannot have a parent location.');
    await expect(
      service.save(
        'staff',
        undefined,
        dto({ kind: 'lga', parentId: undefined }),
      ),
    ).rejects.toThrow('Choose a parent state for this LGA.');
    await expect(
      service.save('staff', undefined, dto({ kind: 'lga', parentId: AMAC })),
    ).rejects.toThrow('Choose an active parent state.');
    await expect(
      service.save(
        'staff',
        undefined,
        dto({ kind: 'area', parentId: undefined }),
      ),
    ).rejects.toThrow('Choose a parent LGA for this area.');
    await expect(
      service.save('staff', undefined, dto({ kind: 'area', parentId: FCT })),
    ).rejects.toThrow('Choose an active parent LGA.');
  });

  it('recomputes ancestorIds for the row and everything under it when the parent changes', async () => {
    const { service, table } = setup();
    await service.save(
      'staff',
      AMAC,
      dto({ kind: 'lga', name: AMAC, parentId: LAGOS, serviceable: true }),
    );
    const byId = (id: string) => table.find((item) => item.id === id)!;
    expect(byId(AMAC)).toMatchObject({ parentId: LAGOS, ancestorIds: [LAGOS] });
    expect(byId(WUSE).ancestorIds).toEqual([LAGOS, AMAC]);
    expect(byId(KUBWA).ancestorIds).toEqual([FCT, BWARI]);
  });

  it('refuses to change the kind of a place that has children', async () => {
    const { service } = setup();
    await expect(
      service.save('staff', FCT, dto({ kind: 'lga', parentId: LAGOS })),
    ).rejects.toThrow('Move or remove the places under this one');
  });

  it('reports a missing place', async () => {
    const { service } = setup();
    await expect(service.save('staff', 'missing', dto({}))).rejects.toThrow(
      'Location not found.',
    );
  });
});
