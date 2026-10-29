import { isLeaf } from './catalog.tree';
import type { CatalogIndex, CatalogNode } from './catalog.types';

export type SkillEntry = { id: string; name: string; rootId: string };

export type ProviderIds = {
  serviceIds: string[];
  skillIds: Record<string, string[]>;
};

type StoredProfile = {
  serviceIds?: unknown;
  skillIds?: unknown;
  services?: unknown;
  skills?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * What a provider can hold for this subtree: the options of each skill
 * question (an option id) and the leaves below the top level that have no
 * skill question on their path (a node id). `activeOnly` follows the
 * customer-facing tree.
 */
export function skillEntries(
  root: CatalogNode,
  options: { activeOnly?: boolean; inheritsSkillQuestion?: boolean } = {},
): SkillEntry[] {
  const activeOnly = options.activeOnly ?? false;
  const walk = (node: CatalogNode, inherits: boolean): SkillEntry[] => {
    if (activeOnly && !node.active) return [];
    const questions = node.questions.filter(
      ({ active, matchesSkill }) => active && matchesSkill,
    );
    const hasSkillQuestion = inherits || questions.length > 0;
    const leaf = activeOnly ? isLeaf(node) : node.children.length === 0;
    return [
      ...questions.flatMap(({ options: choices }) =>
        choices
          .filter(({ active }) => !activeOnly || active)
          .map(({ id, label }) => ({ id, name: label, rootId: root.id })),
      ),
      ...(leaf && !hasSkillQuestion && node.depth >= 1
        ? [{ id: node.id, name: node.name, rootId: root.id }]
        : []),
      ...node.children.flatMap((child) => walk(child, hasSkillQuestion)),
    ];
  };
  return walk(root, options.inheritsSkillQuestion ?? false);
}

/** Every node and option id mapped to its name, inactive ones included, so any id that was ever valid still has a name. */
export function catalogNames(catalog: CatalogIndex): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of catalog.byId.values()) {
    for (const question of node.questions)
      for (const { id, label } of question.options) names.set(id, label);
    names.set(node.id, node.name);
  }
  return names;
}

const normalize = (name: string) => name.trim().toLowerCase();

function matching<T>(
  items: readonly T[],
  name: string,
  nameOf: (item: T) => string,
): T[] {
  const exact = items.filter((item) => nameOf(item) === name);
  if (exact.length) return exact;
  return items.filter((item) => normalize(nameOf(item)) === normalize(name));
}

export function rootByName(
  catalog: CatalogIndex,
  name: string,
): CatalogNode | undefined {
  return matching(catalog.roots, name, (root) => root.name)[0];
}

/**
 * Converts stored names to ids. Skills are matched within their root,
 * inactive entries included. A name that matches nothing is reported in
 * `unmatched` as the bare service name, or as `root › skill`.
 */
export function idsFromNames(
  catalog: CatalogIndex,
  services: readonly string[],
  skills: unknown,
): ProviderIds & { unmatched: string[] } {
  const serviceIds: string[] = [];
  const skillIds: Record<string, string[]> = {};
  const unmatched: string[] = [];
  const skillsByName = isRecord(skills) ? skills : {};
  for (const name of services) {
    const root = rootByName(catalog, name);
    if (!root) {
      unmatched.push(name);
      continue;
    }
    if (serviceIds.includes(root.id)) continue;
    serviceIds.push(root.id);
    const key =
      name in skillsByName
        ? name
        : Object.keys(skillsByName).find(
            (candidate) => normalize(candidate) === normalize(name),
          );
    const entries = skillEntries(root);
    const found: string[] = [];
    for (const skill of unique(strings(key ? skillsByName[key] : []))) {
      const hits = matching(entries, skill, (entry) => entry.name);
      if (hits.length) found.push(...hits.map(({ id }) => id));
      else unmatched.push(`${root.name} › ${skill}`);
    }
    skillIds[root.id] = unique(found);
  }
  return { serviceIds, skillIds, unmatched };
}

/** The current names for stored ids. Ids the catalog doesn't know, such as a deleted option, are dropped. */
export function namesFromIds(
  catalog: CatalogIndex,
  serviceIds: readonly string[],
  skillIds: Readonly<Record<string, readonly string[]>>,
): { services: string[]; skills: Record<string, string[]> } {
  const names = catalogNames(catalog);
  const services: string[] = [];
  const skills: Record<string, string[]> = {};
  for (const id of serviceIds) {
    const name = names.get(id);
    if (name === undefined || services.includes(name)) continue;
    services.push(name);
    skills[name] = unique(
      (skillIds[id] ?? []).flatMap((skillId) => names.get(skillId) ?? []),
    );
  }
  return { services, skills };
}

/** Stored ids when the profile has them, otherwise the ids its names resolve to. The single read fallback until every profile is backfilled. */
export function profileSkillIds(
  catalog: CatalogIndex,
  profile: StoredProfile,
): ProviderIds {
  if (Array.isArray(profile.serviceIds) && isRecord(profile.skillIds))
    return {
      serviceIds: strings(profile.serviceIds),
      skillIds: Object.fromEntries(
        Object.entries(profile.skillIds).map(([rootId, ids]) => [
          rootId,
          strings(ids),
        ]),
      ),
    };
  const { serviceIds, skillIds } = idsFromNames(
    catalog,
    strings(profile.services),
    profile.skills,
  );
  return { serviceIds, skillIds };
}
