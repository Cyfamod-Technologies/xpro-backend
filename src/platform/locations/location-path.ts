import type { Prisma } from '@prisma/client';

export type LocationNode = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  active: boolean;
  serviceable: boolean;
  ancestorIds: string[];
};

export type LocationPathItem = { id: string; kind: string; name: string };

const NODE_SELECT = {
  id: true,
  kind: true,
  name: true,
  parentId: true,
  active: true,
  serviceable: true,
  ancestorIds: true,
} as const;

/** A place is served when it and every ancestor are active and serviceable. `chain` holds the place and its ancestors. */
export function isServedLocation(
  place: Pick<LocationNode, 'id' | 'active' | 'serviceable' | 'ancestorIds'>,
  chain: readonly Pick<LocationNode, 'id' | 'active' | 'serviceable'>[],
): boolean {
  if (!place.active || !place.serviceable) return false;
  return place.ancestorIds.every((id) => {
    const ancestor = chain.find((item) => item.id === id);
    return ancestor?.active === true && ancestor.serviceable;
  });
}

/** The place and its ancestors, root first and the place last; empty when the id is not a known location. */
export async function loadLocationChain(
  db: Pick<Prisma.TransactionClient, 'location'>,
  locationId: unknown,
): Promise<LocationNode[]> {
  if (typeof locationId !== 'string' || !locationId) return [];
  const place = await db.location.findUnique({
    where: { id: locationId },
    select: NODE_SELECT,
  });
  if (!place) return [];
  const ancestors = place.ancestorIds.length
    ? await db.location.findMany({
        where: { id: { in: place.ancestorIds } },
        select: NODE_SELECT,
      })
    : [];
  return [
    ...place.ancestorIds.flatMap((id) =>
      ancestors.filter((ancestor) => ancestor.id === id),
    ),
    place,
  ];
}

export const locationPathOf = (
  chain: readonly LocationPathItem[],
): LocationPathItem[] =>
  chain.map(({ id, kind, name }) => ({ id, kind, name }));

/** Names from the most specific place to the state, e.g. `Life Camp, Abuja Municipal, FCT`. */
export const locationLabelOf = (chain: readonly LocationPathItem[]): string =>
  [...chain]
    .reverse()
    .map(({ name }) => name)
    .join(', ');
