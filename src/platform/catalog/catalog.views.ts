import { descendants } from './catalog.tree';
import { skillEntries, type ProviderIds } from './provider-skills';
import type {
  CatalogIndex,
  CatalogNode,
  CatalogQuestion,
} from './catalog.types';

export type AdminNode = Omit<CatalogNode, 'children'> & {
  usage: { requests: number; providers: number };
  children: AdminNode[];
};

export type CatalogUsageData = {
  leafRequests: ReadonlyMap<string, number>;
  rootRequests: ReadonlyMap<string, number>;
  profiles: readonly ProviderIds[];
};

export function publicQuestion(question: CatalogQuestion) {
  return {
    id: question.id,
    key: question.key,
    label: question.label,
    helpText: question.helpText,
    type: question.type,
    required: question.required,
    options: question.options
      .filter(({ active }) => active)
      .map(({ id, label }) => ({ id, label })),
    config: question.config,
    dateRole: question.dateRole,
    sensitive: question.sensitive,
    matchesSkill: question.matchesSkill,
  };
}

export type PublicNode = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  requiresStartDate: boolean;
  questions: ReturnType<typeof publicQuestion>[];
  children: PublicNode[];
};

export function publicTree(nodes: readonly CatalogNode[]): PublicNode[] {
  return nodes
    .filter(({ active }) => active)
    .map((node) => ({
      id: node.id,
      name: node.name,
      description: node.description,
      icon: node.icon,
      requiresStartDate: node.requiresStartDate,
      questions: node.questions
        .filter(({ active }) => active)
        .map(publicQuestion),
      children: publicTree(node.children),
    }));
}

/** The skill names a provider can hold for this subtree: skill-leaf names and skill-question options. */
export function skillNames(
  node: CatalogNode,
  inheritsSkillQuestion = false,
): string[] {
  return skillEntries(node, { inheritsSkillQuestion }).map(({ name }) => name);
}

export function adminTree(
  catalog: CatalogIndex,
  usage: CatalogUsageData,
): AdminNode[] {
  const build = (node: CatalogNode, rootId: string): AdminNode => {
    const subtree = [node, ...descendants(node)];
    const requests =
      subtree.reduce(
        (total, { id }) => total + (usage.leafRequests.get(id) ?? 0),
        0,
      ) + (node.parentId === null ? (usage.rootRequests.get(node.id) ?? 0) : 0);
    const referenced = new Set(
      subtree.flatMap(({ id, questions }) => [
        id,
        ...questions.flatMap(({ options }) => options.map(({ id }) => id)),
      ]),
    );
    const providers = usage.profiles.filter((profile) =>
      node.parentId === null
        ? profile.serviceIds.includes(node.id)
        : (profile.skillIds[rootId] ?? []).some((id) => referenced.has(id)),
    ).length;
    return {
      ...node,
      usage: { requests, providers },
      children: node.children.map((child) => build(child, rootId)),
    };
  };
  return catalog.roots.map((root) => build(root, root.id));
}

export function flattenAdmin(
  nodes: readonly AdminNode[],
): Map<string, AdminNode> {
  const map = new Map<string, AdminNode>();
  const visit = (node: AdminNode) => {
    map.set(node.id, node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return map;
}

export type RequestCountRows = {
  leaf: Array<{ serviceId: string | null; _count: { _all: number } }>;
  root: Array<{ serviceRootId: string | null; _count: { _all: number } }>;
};

export function requestCounts(rows: RequestCountRows) {
  return {
    leafRequests: new Map(
      rows.leaf.flatMap(({ serviceId, _count }) =>
        serviceId ? [[serviceId, _count._all] as const] : [],
      ),
    ),
    rootRequests: new Map(
      rows.root.flatMap(({ serviceRootId, _count }) =>
        serviceRootId ? [[serviceRootId, _count._all] as const] : [],
      ),
    ),
  };
}
