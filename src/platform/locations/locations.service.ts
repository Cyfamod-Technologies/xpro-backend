import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocationKind, Prisma } from '@prisma/client';
import { ActorService } from '../actor/actor.service';
import { requirePermission } from '../actor/actor.guards';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SaveLocationDto } from './locations.dto';

export type ListOptions = { serviceable?: boolean; includeInactive?: boolean };

export type LocationSummary = {
  id: string;
  name: string;
  /** Name of the root state: the place's own name when it is a state. */
  stateName: string;
};

const PARENT_KIND: Record<LocationKind, LocationKind | null> = {
  state: null,
  lga: 'state',
  area: 'lga',
};

/**
 * Places nest at most three deep (state, LGA, area), so checking the parent chain two levels up covers every ancestor in
 * one query.
 */
function chainWhere(
  options: ListOptions,
  depth = 2,
): Prisma.LocationWhereInput {
  const own: Prisma.LocationWhereInput = options.includeInactive
    ? {}
    : { active: true, ...(options.serviceable ? { serviceable: true } : {}) };
  if (options.includeInactive || depth === 0) return own;
  return {
    ...own,
    OR: [{ parentId: null }, { parent: chainWhere(options, depth - 1) }],
  };
}

const SERVED: ListOptions = { serviceable: true };

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly audit: AuditLogsService,
  ) {}

  /**
   * The states, or the children of `parentId`. `serviceable` keeps only served places; `hasChildren` is counted under
   * the same filters.
   */
  async list(parentId?: string, options: ListOptions = {}) {
    const childWhere: Prisma.LocationWhereInput = options.includeInactive
      ? {}
      : { active: true, ...(options.serviceable ? { serviceable: true } : {}) };
    const rows = await this.prisma.location.findMany({
      where: {
        AND: [
          parentId ? { parentId } : { parentId: null },
          chainWhere(options),
        ],
      },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        kind: true,
        name: true,
        parentId: true,
        aliases: true,
        active: true,
        serviceable: true,
        sort: true,
        _count: { select: { children: { where: childWhere } } },
      },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      hasChildren: _count.children > 0,
    }));
  }

  async adminList(userId: string, parentId?: string, serviceable?: boolean) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'settings.manage');
    return this.list(parentId, { serviceable, includeInactive: true });
  }

  /** The ids among `ids` that are served. */
  async served(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.location.findMany({
      where: { AND: [{ id: { in: [...ids] } }, chainWhere(SERVED)] },
      select: { id: true },
    });
    return new Set(rows.map(({ id }) => id));
  }

  /**
   * For each list of coverage ids, whether it reaches no served place: true when no served place equals, or sits under,
   * any id in the list. One query serves every list.
   */
  async outsideServedAreasFor(
    coverage: readonly (readonly string[])[],
  ): Promise<boolean[]> {
    const all = [...new Set(coverage.flat())];
    if (!all.length) return coverage.map(() => true);
    const served = await this.prisma.location.findMany({
      where: {
        AND: [
          { OR: [{ id: { in: all } }, { ancestorIds: { hasSome: all } }] },
          chainWhere(SERVED),
        ],
      },
      select: { id: true, ancestorIds: true },
    });
    return coverage.map((ids) => {
      const covered = new Set(ids);
      return !served.some(
        (place) =>
          covered.has(place.id) ||
          place.ancestorIds.some((ancestorId) => covered.has(ancestorId)),
      );
    });
  }

  async outsideServedAreas(serviceAreaIds: readonly string[]) {
    const [outside] = await this.outsideServedAreasFor([serviceAreaIds]);
    return outside;
  }

  /** Names for provider views: each place's own name and the name of its state. */
  async summaries(
    ids: readonly (string | null | undefined)[],
  ): Promise<Map<string, LocationSummary>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.location.findMany({
      where: { id: { in: wanted } },
      select: {
        id: true,
        name: true,
        parent: {
          select: { name: true, parent: { select: { name: true } } },
        },
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          stateName: row.parent?.parent?.name ?? row.parent?.name ?? row.name,
        },
      ]),
    );
  }

  /**
   * A provider's home LGA and the places they cover. The LGA must be an active `lga`; coverage can be any active place,
   * served or not.
   */
  async validateProviderLocations(input: {
    locationId?: string | null;
    serviceAreaIds?: readonly string[];
  }) {
    const areaIds = [...new Set(input.serviceAreaIds ?? [])];
    const wanted = [
      ...new Set([...(input.locationId ? [input.locationId] : []), ...areaIds]),
    ];
    const rows = wanted.length
      ? await this.prisma.location.findMany({
          where: { id: { in: wanted }, active: true },
          select: { id: true, kind: true },
        })
      : [];
    const home = rows.find(({ id }) => id === input.locationId);
    if (!home || home.kind !== 'lga')
      // new message: not in spec.
      throw new BadRequestException('Choose your state and LGA from the list.');
    const known = new Set(rows.map(({ id }) => id));
    if (areaIds.some((id) => !known.has(id)))
      // new message: not in spec.
      throw new BadRequestException(
        'Choose service areas from the location list.',
      );
    if (!areaIds.length)
      throw new BadRequestException('Add at least one service area.');
    return { locationId: home.id, serviceAreaIds: areaIds };
  }

  async save(userId: string, id: string | undefined, dto: SaveLocationDto) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'settings.manage');
    const parentKind = PARENT_KIND[dto.kind];
    let parent: { id: string; ancestorIds: string[] } | null = null;
    if (parentKind === null && dto.parentId)
      // new message: not in spec.
      throw new BadRequestException('A state cannot have a parent location.');
    if (parentKind) {
      if (!dto.parentId)
        // new message: not in spec.
        throw new BadRequestException(
          dto.kind === 'lga'
            ? 'Choose a parent state for this LGA.'
            : 'Choose a parent LGA for this area.',
        );
      parent = await this.prisma.location.findFirst({
        where: { id: dto.parentId, kind: parentKind, active: true },
        select: { id: true, ancestorIds: true },
      });
      if (!parent)
        // new message: not in spec.
        throw new BadRequestException(
          dto.kind === 'lga'
            ? 'Choose an active parent state.'
            : 'Choose an active parent LGA.',
        );
    }
    let current: { id: string; kind: string; parentId: string | null } | null =
      null;
    if (id) {
      current = await this.prisma.location.findUnique({
        where: { id },
        select: { id: true, kind: true, parentId: true },
      });
      if (!current) {
        // new message: not in spec.
        throw new NotFoundException('Location not found.');
      }
      if (current.kind !== dto.kind) {
        const hasChildren = await this.prisma.location.count({
          where: { parentId: id },
        });
        if (hasChildren) {
          // new message: not in spec.
          throw new BadRequestException(
            'Move or remove the places under this one before changing its kind.',
          );
        }
      }
    }
    const aliases = [
      ...new Set(dto.aliases.map((alias) => alias.trim()).filter(Boolean)),
    ];
    const data = {
      kind: dto.kind,
      name: dto.name.trim(),
      parentId: parent?.id ?? null,
      ancestorIds: parent ? [...parent.ancestorIds, parent.id] : [],
      aliases,
      active: dto.active,
      serviceable: dto.serviceable,
      sort: dto.sort,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = id
        ? await tx.location.update({ where: { id }, data }).catch(() => {
            // new message: not in spec.
            throw new NotFoundException('Location not found.');
          })
        : await tx.location.create({ data });
      if (current && current.parentId !== saved.parentId)
        await this.refreshDescendants(tx, saved.id, saved.ancestorIds);
      return saved;
    });
    this.audit.record({
      actorType: 'staff',
      actorId: userId,
      entityType: 'location',
      entityId: row.id,
      action: 'location.save',
      metadata: {
        kind: row.kind,
        name: row.name,
        active: row.active,
        serviceable: row.serviceable,
      },
    });
    return row;
  }

  /** Rewrites `ancestorIds` for everything under a place whose own ancestors changed. */
  private async refreshDescendants(
    tx: Prisma.TransactionClient,
    id: string,
    ancestorIds: string[],
  ) {
    let level = [{ id, ancestorIds }];
    while (level.length) {
      const children = await tx.location.findMany({
        where: { parentId: { in: level.map((place) => place.id) } },
        select: { id: true, parentId: true },
      });
      const next: typeof level = [];
      for (const child of children) {
        const parent = level.find((place) => place.id === child.parentId);
        if (!parent) continue;
        const childAncestors = [...parent.ancestorIds, parent.id];
        await tx.location.update({
          where: { id: child.id },
          data: { ancestorIds: childAncestors },
        });
        next.push({ id: child.id, ancestorIds: childAncestors });
      }
      level = next;
    }
  }
}
