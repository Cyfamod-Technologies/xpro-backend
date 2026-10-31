import { createHash } from 'node:crypto';
/** A served state, LGA and area, ids as `district-1` in the request tests. */
export const SERVED_CHAIN = [
  {
    id: 'state-1',
    kind: 'state',
    name: 'FCT',
    parentId: null,
    active: true,
    serviceable: true,
    ancestorIds: [] as string[],
  },
  {
    id: 'city-1',
    kind: 'lga',
    name: 'Abuja Municipal',
    parentId: 'state-1',
    active: true,
    serviceable: true,
    ancestorIds: ['state-1'],
  },
  {
    id: 'district-1',
    kind: 'area',
    name: 'Wuse II',
    parentId: 'city-1',
    active: true,
    serviceable: true,
    ancestorIds: ['state-1', 'city-1'],
  },
];

/** `tx.location` for `loadLocationChain`: the place by id, then its ancestors. */
export function locationStub(chain = SERVED_CHAIN) {
  return {
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(chain.find(({ id }) => id === where.id) ?? null),
    ),
    findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(chain.filter(({ id }) => where.id.in.includes(id))),
    ),
  };
}

/** Ids the `20261031120000_locations_single_source` migration seeds, for tests that need a real, served place. */
export const FCT_ID = '00000000-0000-4000-8000-000000000001';
export const LIFE_CAMP_ID = '00000000-0000-4000-8000-000000000014';
export const KUBWA_ID = '00000000-0000-4000-8000-000000000009';
/** The md5 of `loc:FCT:Abuja Municipal` written as a uuid, the LGA the Abuja areas sit under. */
export const AMAC_ID = md5Uuid('loc:FCT:Abuja Municipal');
/** The md5 of `loc:Lagos` written as a uuid, a seeded state that is not served. */
export const LAGOS_ID = md5Uuid('loc:Lagos');

function md5Uuid(value: string): string {
  // Same as the migration: version nibble 4 and variant nibble 8, so the id passes @IsUUID().
  const md5 = createHash('md5').update(value).digest('hex');
  const hex = `${md5.slice(0, 12)}4${md5.slice(13, 16)}8${md5.slice(17)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
