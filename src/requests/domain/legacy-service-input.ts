import {
  resolveService,
  skillQuestion,
} from '../../platform/catalog/catalog.tree';
import type {
  CatalogIndex,
  ResolvedService,
} from '../../platform/catalog/catalog.types';

const LEGACY_SKILL_KEY: Record<string, string> = {
  Design: 'designType',
  Construction: 'workType',
  Hire: 'trade',
  Procurement: 'category',
  'Facility management': 'serviceNeeds',
  'Waste management': 'wasteType',
};

const LEGACY_ONLY_KEYS = new Set([
  ...Object.values(LEGACY_SKILL_KEY),
  'hireType',
]);

/** Details keys that were skill selectors before the catalog; the sub-service replaces them. */
export function withoutLegacyKeys(
  details: Record<string, unknown>,
  kept: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key]) => key in kept || !LEGACY_ONLY_KEYS.has(key),
    ),
  );
}

export function legacySkill(
  service: string,
  details: Record<string, unknown>,
): string | null {
  const key = LEGACY_SKILL_KEY[service];
  const value = key ? details[key] : undefined;
  return typeof value === 'string' && value ? value : null;
}

export type ServiceInput = {
  serviceId?: unknown;
  service?: unknown;
  details?: unknown;
};

/**
 * Resolves the leaf the customer chose. Without `serviceId`, the pre-catalog
 * `service` name and skill detail still select the root and its sub-service.
 */
export function resolveServiceInput(
  catalog: CatalogIndex,
  input: ServiceInput,
  options: { includeInactive?: boolean } = {},
): ResolvedService | null {
  if (typeof input.serviceId === 'string' && input.serviceId)
    return resolveService(catalog, input.serviceId, options);
  if (typeof input.service !== 'string') return null;
  const root = catalog.roots.find(({ name }) => name === input.service);
  if (!root) return null;
  const details =
    input.details && typeof input.details === 'object'
      ? (input.details as Record<string, unknown>)
      : {};
  const skill = legacySkill(root.name, details);
  const child = skill
    ? root.children.find(
        (node) =>
          node.name === skill ||
          skillQuestion(node.questions)?.options.some(
            ({ label }) => label === skill,
          ),
      )
    : undefined;
  return resolveService(catalog, child?.id ?? root.id, options);
}
