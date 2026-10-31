import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { renameInProfiles } from '../../platform/catalog/catalog-rename';
import type { Seed, SeedSummary } from '../seed.types';
import {
  CATALOG_QUESTIONS,
  CATALOG_SERVICES,
  DEACTIVATED_QUESTION_IDS,
  EXPANDED_GROUPS,
  MIN_CATALOG_DEPTH,
  RENAMED_ROOTS,
  RETIRED_SERVICES,
  type SeedService,
} from './catalog.data';
import { rewriteProfile, type ProviderIdPlan } from './provider-ids';

type Tx = Prisma.TransactionClient;
type ServiceRow = Awaited<ReturnType<Tx['catalogService']['findMany']>>[number];

const MODE_KEY = 'assignment.modeByService';
const DEPTH_KEY = 'catalog.maxDepth';
const PROCUREMENT = 'Procurement';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const siblingKey = (parentId: string | null, name: string) =>
  `${parentId ?? ''}\u0000${name.toLowerCase()}`;

function conflict(name: string): Error {
  return new Error(
    `A service called "${name}" already exists in the same place with another id. Rename or remove it, then run the seed again.`,
  );
}

async function syncServices(tx: Tx, summary: SeedSummary): Promise<void> {
  const rows = await tx.catalogService.findMany();
  const existing = new Map<string, ServiceRow>(rows.map((r) => [r.id, r]));
  const names = new Map(
    rows.map((r) => [siblingKey(r.parentId, r.name), r.id]),
  );

  const visit = async (
    nodes: readonly SeedService[],
    parentId: string | null,
    depth: number,
  ) => {
    for (const [index, node] of nodes.entries()) {
      const row = existing.get(node.id);
      const key = siblingKey(parentId, node.name);
      const holder = names.get(key);
      if (holder !== undefined && holder !== node.id) throw conflict(node.name);
      if (!row) {
        await tx.catalogService.create({
          data: {
            id: node.id,
            parentId,
            name: node.name,
            description: node.description ?? node.initialDescription ?? null,
            depth,
            sortOrder: index,
            requiresStartDate: node.requiresStartDate ?? false,
          },
        });
        names.set(key, node.id);
        summary.servicesCreated++;
      } else {
        const data: Prisma.CatalogServiceUncheckedUpdateInput = {};
        if (row.name !== node.name) data.name = node.name;
        if (row.parentId !== parentId) data.parentId = parentId;
        if (row.depth !== depth) data.depth = depth;
        if (row.sortOrder !== index) data.sortOrder = index;
        if (
          node.description !== undefined &&
          row.description !== node.description
        )
          data.description = node.description;
        if (Object.keys(data).length) {
          await tx.catalogService.update({
            where: { id: node.id },
            data: { ...data, version: { increment: 1 } },
          });
          names.delete(siblingKey(row.parentId, row.name));
          names.set(key, node.id);
          summary.servicesUpdated++;
        }
      }
      await visit(node.children ?? [], node.id, depth + 1);
    }
  };
  await visit(CATALOG_SERVICES, null, 0);
}

async function syncQuestions(tx: Tx, summary: SeedSummary): Promise<void> {
  const present = await tx.serviceQuestion.findMany({
    select: { id: true, serviceId: true, key: true },
  });
  const ids = new Set(present.map(({ id }) => id));
  const keys = new Set(present.map((q) => `${q.serviceId}:${q.key}`));
  for (const question of CATALOG_QUESTIONS) {
    if (
      ids.has(question.id) ||
      keys.has(`${question.serviceId}:${question.key}`)
    )
      continue;
    await tx.serviceQuestion.create({
      data: {
        id: question.id,
        serviceId: question.serviceId,
        key: question.key,
        label: question.label,
        type: question.type,
        required: question.required,
        sortOrder: question.sortOrder,
        options: question.options,
        config: question.config as Prisma.InputJsonObject,
        dateRole: question.dateRole,
        sensitive: question.sensitive,
      },
    });
    summary.questionsCreated++;
  }
  const { count } = await tx.serviceQuestion.updateMany({
    where: { id: { in: DEACTIVATED_QUESTION_IDS }, active: true },
    data: { active: false, version: { increment: 1 } },
  });
  summary.questionsDeactivated += count;
}

/** Mirrors `CatalogService.deleteService`: deactivate, and delete only a childless node no request uses. */
async function retireServices(tx: Tx, summary: SeedSummary): Promise<string[]> {
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const { id } of RETIRED_SERVICES) {
    const node = await tx.catalogService.findUnique({
      where: { id },
      include: { _count: { select: { children: true } } },
    });
    if (!node) continue;
    if (node.active) {
      await tx.catalogService.update({
        where: { id },
        data: { active: false, version: { increment: 1 } },
      });
      summary.servicesDeactivated++;
    }
    const requests = await tx.serviceRequest.count({
      where: { OR: [{ serviceId: id }, { serviceRootId: id }] },
    });
    if (node._count.children === 0 && requests === 0) {
      await tx.catalogService.delete({ where: { id } });
      deleted.push(id);
      summary.servicesDeleted++;
    } else {
      kept.push(id);
    }
  }
  // A retired node that stays sorts after the active ones.
  for (const id of kept) {
    const node = await tx.catalogService.findUniqueOrThrow({ where: { id } });
    const siblings = node.parentId
      ? findSeedChildren(CATALOG_SERVICES, node.parentId)
      : CATALOG_SERVICES;
    if (siblings && node.sortOrder < siblings.length)
      await tx.catalogService.update({
        where: { id },
        data: { sortOrder: siblings.length },
      });
  }
  return deleted;
}

function findSeedChildren(
  nodes: readonly SeedService[],
  id: string,
): readonly SeedService[] | undefined {
  for (const node of nodes) {
    if (node.id === id) return node.children ?? [];
    const found = findSeedChildren(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function findSeedNode(
  nodes: readonly SeedService[],
  id: string,
): SeedService | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findSeedNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

async function renameRoots(tx: Tx, summary: SeedSummary): Promise<void> {
  for (const { from, to } of RENAMED_ROOTS) {
    const { count } = await tx.serviceRequest.updateMany({
      where: { service: from },
      data: { service: to },
    });
    summary.requestsRenamed += count;
    summary.profilesRenamed += await renameInProfiles(tx, {
      root: null,
      from,
      to,
    });
  }
}

async function syncSettings(tx: Tx, summary: SeedSummary): Promise<void> {
  // Not written to settings_history: a seed has no actor to attribute the change to.
  const modes = await tx.setting.findUnique({ where: { key: MODE_KEY } });
  if (modes && isRecord(modes.value)) {
    const renames = new Map(RENAMED_ROOTS.map(({ from, to }) => [from, to]));
    if (Object.keys(modes.value).some((name) => renames.has(name))) {
      const value = Object.fromEntries(
        Object.entries(modes.value).map(([name, mode]) => [
          renames.get(name) ?? name,
          mode,
        ]),
      );
      await tx.setting.update({
        where: { key: MODE_KEY },
        data: {
          value,
          version: { increment: 1 },
        },
      });
      summary.settingsUpdated++;
    }
  }
  const depth = await tx.setting.findUnique({ where: { key: DEPTH_KEY } });
  if (
    depth &&
    typeof depth.value === 'number' &&
    depth.value < MIN_CATALOG_DEPTH
  ) {
    await tx.setting.update({
      where: { key: DEPTH_KEY },
      data: { value: MIN_CATALOG_DEPTH, version: { increment: 1 } },
    });
    summary.settingsUpdated++;
  }
}

async function rewriteProviders(
  tx: Tx,
  deleted: readonly string[],
  summary: SeedSummary,
): Promise<void> {
  const groups = new Map(
    EXPANDED_GROUPS.groupIds.map((id) => [
      id,
      (findSeedNode(CATALOG_SERVICES, id)?.children ?? []).map((c) => c.id),
    ]),
  );
  const procurement = RETIRED_SERVICES.find(({ name }) => name === PROCUREMENT);
  const plan: ProviderIdPlan = {
    rootId: EXPANDED_GROUPS.rootId,
    groups,
    removedIds: new Set(deleted),
    removedNames: new Set(
      procurement && deleted.includes(procurement.id) ? [PROCUREMENT] : [],
    ),
  };
  const profiles = await tx.providerProfile.findMany({
    select: {
      id: true,
      services: true,
      skills: true,
      serviceIds: true,
      skillIds: true,
      pendingChanges: true,
    },
  });
  for (const profile of profiles) {
    const data = rewriteProfile(profile, plan);
    if (!data) continue;
    await tx.providerProfile.update({ where: { id: profile.id }, data });
    summary.profilesUpdated++;
  }
}

export async function applyCatalog(tx: Tx): Promise<SeedSummary> {
  const summary: SeedSummary = {
    servicesCreated: 0,
    servicesUpdated: 0,
    questionsCreated: 0,
    questionsDeactivated: 0,
    servicesDeactivated: 0,
    servicesDeleted: 0,
    requestsRenamed: 0,
    profilesRenamed: 0,
    profilesUpdated: 0,
    settingsUpdated: 0,
  };
  await syncSettings(tx, summary);
  await syncServices(tx, summary);
  await syncQuestions(tx, summary);
  await renameRoots(tx, summary);
  const deleted = await retireServices(tx, summary);
  await rewriteProviders(tx, deleted, summary);
  return summary;
}

const checksum = createHash('sha256')
  .update(
    JSON.stringify([
      CATALOG_SERVICES,
      CATALOG_QUESTIONS,
      RENAMED_ROOTS,
      RETIRED_SERVICES,
      DEACTIVATED_QUESTION_IDS,
      EXPANDED_GROUPS,
    ]),
  )
  .digest('hex');

export const catalogSeed: Seed = {
  name: 'catalog',
  version: 1,
  checksum,
  apply: applyCatalog,
};
