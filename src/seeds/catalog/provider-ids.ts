import type { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';

export type ProviderIdPlan = {
  /** Skill ids of this root: a listed group id is replaced by its leaf ids. */
  rootId: string;
  groups: ReadonlyMap<string, readonly string[]>;
  /** Deleted catalog ids, dropped from every provider. */
  removedIds: ReadonlySet<string>;
  /** Deleted root names, dropped from the legacy `services` and `skills`. */
  removedNames: ReadonlySet<string>;
};

type Stored = {
  services: unknown;
  skills: unknown;
  serviceIds: unknown;
  skillIds: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function dropFromList(list: unknown, removed: ReadonlySet<string>): unknown {
  return Array.isArray(list)
    ? (list as unknown[]).filter(
        (item) => !(typeof item === 'string' && removed.has(item)),
      )
    : list;
}

function expandList(
  list: unknown,
  groups: ReadonlyMap<string, readonly string[]>,
): unknown {
  if (!Array.isArray(list)) return list;
  return unique(
    (list as unknown[]).flatMap((item) =>
      typeof item === 'string' && groups.has(item)
        ? [...groups.get(item)!]
        : [item],
    ),
  );
}

function rewriteSkillIds(map: unknown, plan: ProviderIdPlan): unknown {
  if (!isRecord(map)) return map;
  return Object.fromEntries(
    Object.entries(map)
      .filter(([rootId]) => !plan.removedIds.has(rootId))
      .map(([rootId, ids]) => {
        const expanded =
          rootId === plan.rootId ? expandList(ids, plan.groups) : ids;
        return [rootId, dropFromList(expanded, plan.removedIds)];
      }),
  );
}

function rewriteNames(
  services: unknown,
  skills: unknown,
  names: ReadonlySet<string>,
): { services: unknown; skills: unknown } {
  return {
    services: dropFromList(services, names),
    skills: isRecord(skills)
      ? Object.fromEntries(
          Object.entries(skills).filter(([name]) => !names.has(name)),
        )
      : skills,
  };
}

function rewrite(stored: Stored, plan: ProviderIdPlan): Stored {
  return {
    serviceIds: dropFromList(stored.serviceIds, plan.removedIds),
    skillIds: rewriteSkillIds(stored.skillIds, plan),
    ...rewriteNames(stored.services, stored.skills, plan.removedNames),
  };
}

/**
 * What a provider profile (and its pending changes) becomes under the plan, or
 * null when nothing changes. Absent and null fields stay as they are.
 */
export function rewriteProfile(
  profile: Stored & { pendingChanges: unknown },
  plan: ProviderIdPlan,
): Prisma.ProviderProfileUpdateInput | null {
  const data: Prisma.ProviderProfileUpdateInput = {};
  const live = rewrite(profile, plan);
  if (!isDeepStrictEqual(live.serviceIds, profile.serviceIds))
    data.serviceIds = live.serviceIds as Prisma.InputJsonValue;
  if (!isDeepStrictEqual(live.skillIds, profile.skillIds))
    data.skillIds = live.skillIds as Prisma.InputJsonValue;
  if (!isDeepStrictEqual(live.services, profile.services))
    data.services = live.services as Prisma.InputJsonValue;
  if (!isDeepStrictEqual(live.skills, profile.skills))
    data.skills = live.skills as Prisma.InputJsonValue;

  if (isRecord(profile.pendingChanges)) {
    const pending = rewrite(profile.pendingChanges as Stored, plan);
    const next: Record<string, unknown> = { ...profile.pendingChanges };
    for (const key of Object.keys(pending) as Array<keyof Stored>)
      if (key in profile.pendingChanges) next[key] = pending[key];
    if (!isDeepStrictEqual(next, profile.pendingChanges))
      data.pendingChanges = next as Prisma.InputJsonValue;
  }
  return Object.keys(data).length ? data : null;
}
