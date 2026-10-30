import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActorService } from '../actor/actor.service';
import { requirePermission } from '../actor/actor.guards';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SaveLocationDto } from './locations.dto';
import { matchLocationName } from './location-matching';
import {
  findBuiltInArea,
  findBuiltInCity,
  findBuiltInState,
} from './builtin-locations';

export type LocationValue = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  aliases: string[];
  active: boolean;
  sort: number;
};

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly audit: AuditLogsService,
  ) {}

  async list(parentId?: string, includeInactive = false) {
    return this.prisma.location.findMany({
      where: {
        ...(parentId ? { parentId } : { parentId: null }),
        ...(includeInactive ? {} : { active: true }),
        ...(parentId && !includeInactive ? { parent: { active: true } } : {}),
      },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        kind: true,
        name: true,
        parentId: true,
        aliases: true,
        active: true,
        sort: true,
      },
    });
  }

  async adminList(userId: string, parentId?: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'settings.manage');
    return this.list(parentId, true);
  }

  async allActive(): Promise<LocationValue[]> {
    const rows = await this.prisma.location.findMany({
      where: { active: true },
      select: {
        id: true,
        kind: true,
        name: true,
        parentId: true,
        aliases: true,
        active: true,
        sort: true,
      },
    });
    const activeCityIds = new Set(
      rows
        .filter(({ kind, parentId }) => kind === 'city' && !parentId)
        .map(({ id }) => id),
    );
    return rows.filter(
      ({ kind, parentId }) =>
        kind === 'city' ||
        (kind === 'district' && parentId && activeCityIds.has(parentId)),
    );
  }

  /**
   * Providers choose a state and city from the built-in Nigeria list, so no admin setup is needed. A city or area that
   * is also a managed location keeps its id, which is what dispatch matches on; anything else is saved by name only.
   */
  async resolveProviderLocationIds(input: {
    state?: string;
    cityId?: string;
    city?: string;
    serviceAreaIds?: string[];
    serviceAreas?: string[];
  }) {
    const locations = await this.allActive();
    const cities = locations.filter((location) => location.kind === 'city');
    const findNamed = (name: string | undefined, kind: string) => {
      if (!name?.trim()) return undefined;
      return matchLocationName(name, locations, kind);
    };
    const managedCity = input.cityId
      ? cities.find((location) => location.id === input.cityId)
      : findNamed(input.city, 'city');
    if (input.cityId && !managedCity)
      // new message: not in spec.
      throw new BadRequestException('Choose an active city from the list.');
    const builtInCity = managedCity
      ? undefined
      : findBuiltInCity(input.state, input.city);
    if (!managedCity && !builtInCity) {
      // new message: not in spec.
      throw new BadRequestException(
        'Choose your state and city from the list.',
      );
    }
    const state = findBuiltInState(input.state)?.name ?? builtInCity?.state;

    let areaIds: string[];
    let areaNames: string[];
    if (input.serviceAreaIds?.length) {
      const validIds = new Set(locations.map(({ id }) => id));
      if (input.serviceAreaIds.some((id) => !validIds.has(id)))
        // new message: not in spec.
        throw new BadRequestException(
          'Choose active service areas from the list.',
        );
      areaIds = [...new Set(input.serviceAreaIds)];
      areaNames = locations
        .filter(({ id }) => areaIds.includes(id))
        .map(({ name }) => name);
    } else {
      const named = (input.serviceAreas ?? []).map((name) => {
        const managed = findNamed(name, 'city') ?? findNamed(name, 'district');
        return {
          id: managed?.id,
          name: managed?.name ?? findBuiltInArea(name),
        };
      });
      if (named.some((area) => !area.name)) {
        // new message: not in spec.
        throw new BadRequestException(
          'Choose service areas from the location list.',
        );
      }
      areaIds = [
        ...new Set(named.flatMap((area) => (area.id ? [area.id] : []))),
      ];
      areaNames = [...new Set(named.map((area) => area.name!))];
    }

    if (!areaNames.length)
      throw new BadRequestException('Add at least one service area.');
    return {
      cityId: managedCity?.id,
      state,
      serviceAreaIds: areaIds,
      cityName: managedCity?.name ?? builtInCity!.city,
      serviceAreaNames: areaNames,
    };
  }

  async save(userId: string, id: string | undefined, dto: SaveLocationDto) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'settings.manage');
    if (dto.kind === 'city' && dto.parentId)
      // new message: not in spec.
      throw new BadRequestException('A city cannot have a parent location.');
    if (dto.kind === 'district') {
      if (!dto.parentId)
        // new message: not in spec.
        throw new BadRequestException(
          'Choose a parent city for this district.',
        );
      const parent = await this.prisma.location.findFirst({
        where: { id: dto.parentId, kind: 'city', active: true },
      });
      if (!parent)
        // new message: not in spec.
        throw new BadRequestException('Choose an active parent city.');
    }
    if (id) {
      const current = await this.prisma.location.findUnique({
        where: { id },
        select: { id: true, kind: true },
      });
      if (!current) {
        // new message: not in spec.
        throw new NotFoundException('Location not found.');
      }
      if (current.kind === 'city' && dto.kind !== 'city') {
        const hasChildren = await this.prisma.location.count({
          where: { parentId: id },
        });
        if (hasChildren) {
          // new message: not in spec.
          throw new BadRequestException(
            'Move or remove child districts before changing this city.',
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
      parentId: dto.parentId ?? null,
      aliases,
      active: dto.active,
      sort: dto.sort,
    };
    const row = id
      ? await this.prisma.location.update({ where: { id }, data }).catch(() => {
          // new message: not in spec.
          throw new NotFoundException('Location not found.');
        })
      : await this.prisma.location.create({ data });
    this.audit.record({
      actorType: 'staff',
      actorId: userId,
      entityType: 'location',
      entityId: row.id,
      action: 'location.save',
      metadata: { kind: row.kind, name: row.name, active: row.active },
    });
    return row;
  }
}
