import { ConflictException, Injectable } from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../actor/actor.service';
import { requirePermission } from '../actor/actor.guards';
import type { ActorContext } from '../actor/actor.types';
import { SettingsService } from '../settings/settings.service';
import {
  DEFAULT_MAX_DEPTH,
  MAX_DEPTH_KEY,
  assertSameSet,
  deepestLevels,
  invalid,
  notFound,
  siblingsOf,
  skillLeaf,
} from './catalog.rules';
import { renameInProfiles } from './catalog-rename';
import { loadCatalog, pathTo, withCatalogLock } from './catalog.tree';
import { profileSkillIds } from './provider-skills';
import {
  adminTree,
  flattenAdmin,
  publicTree,
  requestCounts,
  type AdminNode,
} from './catalog.views';
import type {
  CatalogSettingsDto,
  CreateServiceDto,
  ReorderServicesDto,
  UpdateServiceDto,
} from './dto/catalog.dto';

export const versionConflict = (what: string) =>
  new ConflictException(
    `This ${what} changed since you opened it. Reload and try again.`,
  );

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly audit: AuditLogsService,
    private readonly settings: SettingsService,
  ) {}

  async publicTree() {
    return publicTree((await loadCatalog(this.prisma)).roots);
  }

  async requireManager(userId: string): Promise<ActorContext> {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'catalog.manage');
    return actor;
  }

  async maxDepth(db: Pick<PrismaService, 'setting'>): Promise<number> {
    const row = await db.setting.findUnique({ where: { key: MAX_DEPTH_KEY } });
    return typeof row?.value === 'number' ? row.value : DEFAULT_MAX_DEPTH;
  }

  async adminCatalog(userId: string) {
    await this.requireManager(userId);
    return {
      maxDepth: await this.maxDepth(this.prisma),
      services: await this.adminNodes(),
    };
  }

  async adminNode(id: string): Promise<AdminNode> {
    const node = flattenAdmin(await this.adminNodes()).get(id);
    if (!node) throw notFound('Service not found.');
    return node;
  }

  private async adminNodes(): Promise<AdminNode[]> {
    const [catalog, leaf, root, profiles] = await Promise.all([
      loadCatalog(this.prisma),
      this.prisma.serviceRequest.groupBy({
        by: ['serviceId'],
        where: { serviceId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.serviceRequest.groupBy({
        by: ['serviceRootId'],
        where: { serviceId: null, serviceRootId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.providerProfile.findMany({
        select: {
          services: true,
          skills: true,
          serviceIds: true,
          skillIds: true,
        },
      }),
    ]);
    return adminTree(catalog, {
      ...requestCounts({ leaf, root }),
      profiles: profiles.map((profile) => profileSkillIds(catalog, profile)),
    });
  }

  async createService(userId: string, dto: CreateServiceDto) {
    const actor = await this.requireManager(userId);
    const id = await withCatalogLock(this.prisma, async (tx, catalog) => {
      const parent = dto.parentId ? catalog.byId.get(dto.parentId) : undefined;
      if (dto.parentId && !parent) throw notFound('Parent service not found.');
      const depth = parent ? parent.depth + 1 : 0;
      const maxDepth = await this.maxDepth(tx);
      if (depth >= maxDepth)
        throw invalid(
          `Services can be nested up to ${maxDepth} levels. Raise the limit before adding another level.`,
        );
      const name = cleanName(dto.name);
      const siblings = siblingsOf(catalog, parent?.id ?? null);
      assertNameFree(siblings, name);
      const row = await tx.catalogService.create({
        data: {
          parentId: parent?.id ?? null,
          name,
          description: dto.description?.trim() || null,
          icon: dto.icon?.trim() || null,
          depth,
          sortOrder: Math.max(-1, ...siblings.map((s) => s.sortOrder)) + 1,
          requiresStartDate: dto.requiresStartDate ?? false,
        },
      });
      return row.id;
    });
    this.record(actor, 'catalog.service.created', id, {
      name: dto.name.trim(),
      parentId: dto.parentId ?? null,
    });
    return this.adminNode(id);
  }

  async updateService(userId: string, id: string, dto: UpdateServiceDto) {
    const actor = await this.requireManager(userId);
    const changed = await withCatalogLock(this.prisma, async (tx, catalog) => {
      const node = catalog.byId.get(id);
      if (!node) throw notFound('Service not found.');
      if (dto.version !== node.version) throw versionConflict('service');
      const data: Record<string, unknown> = {};
      if (dto.name !== undefined) {
        const name = cleanName(dto.name);
        if (name !== node.name) {
          assertNameFree(siblingsOf(catalog, node.parentId), name, node.id);
          data.name = name;
        }
      }
      for (const field of ['description', 'icon'] as const) {
        const value = dto[field];
        if (value !== undefined && (value.trim() || null) !== node[field])
          data[field] = value.trim() || null;
      }
      for (const field of ['active', 'requiresStartDate'] as const) {
        const value = dto[field];
        if (value !== undefined && value !== node[field]) data[field] = value;
      }
      if (!Object.keys(data).length) return null;
      await tx.catalogService.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
      if (typeof data.name === 'string') {
        if (node.depth === 0)
          await renameInProfiles(tx, {
            root: null,
            from: node.name,
            to: data.name,
          });
        else if (skillLeaf(catalog, node))
          await renameInProfiles(tx, {
            root: pathTo(catalog, node.id)[0].name,
            from: node.name,
            to: data.name,
          });
      }
      return Object.keys(data);
    });
    if (changed)
      this.record(actor, 'catalog.service.updated', id, { fields: changed });
    return this.adminNode(id);
  }

  async deleteService(userId: string, id: string) {
    const actor = await this.requireManager(userId);
    const name = await withCatalogLock(this.prisma, async (tx, catalog) => {
      const node = catalog.byId.get(id);
      if (!node) throw notFound('Service not found.');
      if (node.children.length)
        throw invalid('Delete its sub-services first, or deactivate it.');
      const requests = await tx.serviceRequest.count({
        where: { OR: [{ serviceId: id }, { serviceRootId: id }] },
      });
      if (requests)
        throw invalid(
          'Requests already use this service. Deactivate it instead.',
        );
      await tx.catalogService.delete({ where: { id } });
      return node.name;
    });
    this.record(actor, 'catalog.service.deleted', id, { name });
    return { id };
  }

  async reorderServices(userId: string, dto: ReorderServicesDto) {
    const actor = await this.requireManager(userId);
    await withCatalogLock(this.prisma, async (tx, catalog) => {
      if (dto.parentId && !catalog.byId.has(dto.parentId))
        throw notFound('Parent service not found.');
      const siblings = siblingsOf(catalog, dto.parentId);
      assertSameSet(
        siblings.map(({ id }) => id),
        dto.ids,
      );
      for (const [index, id] of dto.ids.entries())
        if (siblings.find((s) => s.id === id)?.sortOrder !== index)
          await tx.catalogService.update({
            where: { id },
            data: { sortOrder: index },
          });
    });
    this.record(actor, 'catalog.service.reordered', dto.parentId, {
      ids: dto.ids,
    });
    return { parentId: dto.parentId, ids: dto.ids };
  }

  async saveSettings(
    user: { id: string; sid?: string },
    dto: CatalogSettingsDto,
  ) {
    const actor = await this.requireManager(user.id);
    const [current, catalog] = await Promise.all([
      this.settings.snapshot(),
      loadCatalog(this.prisma),
    ]);
    const levels = deepestLevels(catalog);
    if (dto.maxDepth < levels)
      throw invalid(
        `The catalog already has ${levels} levels. Delete the deepest services before lowering the limit.`,
      );
    const setting = current.find(({ key }) => key === MAX_DEPTH_KEY);
    if (setting?.value !== dto.maxDepth)
      await this.settings.save(
        actor,
        [
          {
            key: MAX_DEPTH_KEY,
            value: dto.maxDepth,
            expectedVersion: setting?.version ?? 1,
          },
        ],
        'Service catalog depth limit changed',
        undefined,
        user.sid,
        'catalog.manage',
      );
    return { maxDepth: dto.maxDepth };
  }

  record(
    actor: ActorContext,
    action: string,
    entityId: string | null,
    metadata: Record<string, unknown>,
  ) {
    this.audit.record({
      actorType: 'staff',
      actorId: actor.userId,
      entityType:
        action.split('.')[1] === 'question'
          ? 'catalog_question'
          : 'catalog_service',
      entityId,
      action,
      metadata,
    });
  }
}

export function cleanName(value: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > 80)
    throw invalid('Add a name of 2 to 80 characters.');
  return name;
}

function assertNameFree(
  siblings: ReadonlyArray<{ id: string; name: string }>,
  name: string,
  selfId?: string,
): void {
  if (
    siblings.some(
      (sibling) =>
        sibling.id !== selfId &&
        sibling.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw invalid(`A service called "${name}" already exists here.`);
}
