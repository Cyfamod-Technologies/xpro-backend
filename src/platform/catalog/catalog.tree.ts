import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type {
  CatalogIndex,
  CatalogNode,
  CatalogOption,
  CatalogQuestion,
  ResolvedService,
} from './catalog.types';

export const CATALOG_INCLUDE = {
  questions: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.CatalogServiceInclude;

type CatalogRow = Prisma.CatalogServiceGetPayload<{
  include: typeof CATALOG_INCLUDE;
}>;
type QuestionRow = CatalogRow['questions'][number];

export type CatalogDb = Pick<Prisma.TransactionClient, 'catalogService'>;

export function toOptions(value: unknown): CatalogOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const { id, label, active } = item as Record<string, unknown>;
    return typeof id === 'string' && typeof label === 'string'
      ? [{ id, label, active: active !== false }]
      : [];
  });
}

export function toQuestion(row: QuestionRow): CatalogQuestion {
  return {
    id: row.id,
    serviceId: row.serviceId,
    key: row.key,
    label: row.label,
    helpText: row.helpText,
    type: row.type,
    required: row.required,
    sortOrder: row.sortOrder,
    active: row.active,
    options: toOptions(row.options),
    config:
      row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config
        : {},
    dateRole: row.dateRole,
    sensitive: row.sensitive,
    matchesSkill: row.matchesSkill,
    version: row.version,
  };
}

export function buildCatalog(rows: readonly CatalogRow[]): CatalogIndex {
  const byId = new Map<string, CatalogNode>();
  for (const row of rows)
    byId.set(row.id, {
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      description: row.description,
      icon: row.icon,
      depth: row.depth,
      sortOrder: row.sortOrder,
      active: row.active,
      requiresStartDate: row.requiresStartDate,
      version: row.version,
      questions: row.questions.map(toQuestion).sort(bySortOrder),
      children: [],
    });
  const roots: CatalogNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  roots.sort(bySortOrder);
  for (const node of byId.values()) node.children.sort(bySortOrder);
  return { roots, byId };
}

export async function loadCatalog(db: CatalogDb): Promise<CatalogIndex> {
  return buildCatalog(
    await db.catalogService.findMany({ include: CATALOG_INCLUDE }),
  );
}

const bySortOrder = (
  left: { sortOrder: number; id: string },
  right: { sortOrder: number; id: string },
) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);

export function pathTo(catalog: CatalogIndex, id: string): CatalogNode[] {
  const path: CatalogNode[] = [];
  let current = catalog.byId.get(id);
  while (current) {
    path.unshift(current);
    current = current.parentId ? catalog.byId.get(current.parentId) : undefined;
  }
  return path;
}

export function descendants(node: CatalogNode): CatalogNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

/** Customers pick a leaf: a node with no active children. */
export function isLeaf(node: CatalogNode): boolean {
  return !node.children.some(({ active }) => active);
}

/** Active questions of the path, ancestors first, then in their own order. */
export function inheritedQuestions(path: readonly CatalogNode[]) {
  return path.flatMap((node) => node.questions.filter(({ active }) => active));
}

export function resolveService(
  catalog: CatalogIndex,
  serviceId: string,
  options: { includeInactive?: boolean } = {},
): ResolvedService | null {
  const path = pathTo(catalog, serviceId);
  if (!path.length || path[0].parentId !== null) return null;
  if (
    !options.includeInactive &&
    (path.some(({ active }) => !active) || !isLeaf(path[path.length - 1]))
  )
    return null;
  return { path, questions: inheritedQuestions(path) };
}

export function skillQuestion(
  questions: readonly CatalogQuestion[],
): CatalogQuestion | undefined {
  return questions.find(({ matchesSkill }) => matchesSkill);
}

/** Serialises catalog writes so the structural rules see a stable tree. */
export function withCatalogLock<T>(
  prisma: Pick<PrismaService, '$transaction'>,
  run: (tx: Prisma.TransactionClient, catalog: CatalogIndex) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'catalog'}, 0))`;
    return run(tx, await loadCatalog(tx));
  });
}
