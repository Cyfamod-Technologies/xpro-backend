import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StaffPermission } from '../staff/staff-permissions';
import type { RequestUser } from '../common/types/request-user';
import { paginationArgs, toPaginatedResult } from '../common/utils/paginate';
import { ActorService } from '../platform/actor/actor.service';
import { AppError } from '../platform/errors/app-error';
import { SettingsService } from '../platform/settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseRequestId } from './domain/statuses';
import { deriveStage, nextActor } from './domain/stage';
import { RequestListQueryDto } from './dto/request-list-query.dto';
import { RequestActivityQueryDto } from './dto/request-activity-query.dto';
import { RequestSnapshotLoader } from './snapshot.loader';
import { customerProjection } from './projections/customer.projection';
import { listProjection } from './projections/list.projection';
import { providerProjection } from './projections/provider.projection';
import { ProjectionContext } from './projections/projection.helpers';
import { staffProjection } from './projections/staff.projection';

const OPAQUE_MESSAGE = 'This request is no longer available to your account.';
const ACCESSIBLE_ASSIGNMENTS = ['offered', 'pending_approval', 'accepted', 'completed'] as const;

@Injectable()
export class RequestsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly loader: RequestSnapshotLoader,
    private readonly settingsService: SettingsService,
  ) {}

  async list(user: RequestUser, query: RequestListQueryDto) {
    const actor = await this.actors.resolve(user.id);
    const staff = actor.kind === 'staff' && actor.staff?.status === 'active';
    const providerScoped = !staff && actor.platformRoles.includes('provider');
    const providerScope: Prisma.ServiceRequestWhereInput = {
      assignments: { some: { providerUserId: user.id, status: { in: [...ACCESSIBLE_ASSIGNMENTS] } } },
    };
    const filters: Prisma.ServiceRequestWhereInput[] = [];
    if (staff) {
      if (query.owner) filters.push({ ownerId: query.owner });
    } else if (actor.platformRoles.includes('provider')) {
      filters.push(actor.platformRoles.includes('customer')
        ? { OR: [{ ownerId: user.id }, providerScope] }
        : providerScope);
    } else {
      filters.push({ ownerId: user.id });
    }
    if (query.status) filters.push({ status: query.status as Prisma.ServiceRequestWhereInput['status'] });
    if (query.service) filters.push({ service: query.service });
    if (query.q && !providerScoped) filters.push({
      OR: [
        { title: { contains: query.q, mode: 'insensitive' } },
        ...(parseRequestId(query.q) === null ? [] : [{ number: parseRequestId(query.q)! }]),
      ],
    });
    const where: Prisma.ServiceRequestWhereInput = { AND: filters };
    const page = query.page ?? 1;
    const limit = query.itemsPerPage ?? 20;
    const needsDerivedFiltering = Boolean(query.stage || query.nextActor || (query.q && providerScoped));
    const rowQuery = this.prisma.serviceRequest.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      ...(needsDerivedFiltering ? {} : paginationArgs(page, limit)),
    });
    const [rows, dbTotal] = needsDerivedFiltering
      ? [await rowQuery, null] as const
      : await this.prisma.$transaction([rowQuery, this.prisma.serviceRequest.count({ where })]);
    const settings = Object.fromEntries((await this.settingsService.snapshot()).map(({ key, value }) => [key, value]));
    const now = new Date();
    const matching: Array<NonNullable<Awaited<ReturnType<RequestSnapshotLoader['load']>>>> = [];
    for (const brief of rows) {
      const loaded = await this.loader.load(this.prisma, brief.id);
      if (!loaded || !this.canSee(loaded.snapshot, actor)) continue;
      if (query.stage && deriveStage(loaded.snapshot, now) !== query.stage) continue;
      if (query.nextActor === 'me' && !this.isNextActor(loaded.snapshot, actor, now)) continue;
      if (query.q && !this.matchesSearch(loaded.row.number, loaded.row.title, loaded.snapshot, actor, query.q, staff)) continue;
      matching.push(loaded);
    }
    const start = (page - 1) * limit;
    return toPaginatedResult(
      (needsDerivedFiltering ? matching.slice(start, start + limit) : matching)
        .map(({ row, snapshot }) => listProjection(row, snapshot, actor, now, settings)),
      dbTotal ?? matching.length,
      page,
      limit,
    );
  }

  async detail(user: RequestUser, id: string) {
    const actor = await this.actors.resolve(user.id);
    const loaded = await this.loader.load(this.prisma, id);
    if (!loaded || !this.canSee(loaded.snapshot, actor)) throw this.notFound();
    const role = actor.kind === 'staff' && actor.staff?.status === 'active'
      ? 'staff'
      : loaded.snapshot.ownerId === actor.userId
        ? 'customer'
        : actor.platformRoles.includes('provider')
          ? 'provider'
          : 'customer';
    const settings = Object.fromEntries((await this.settingsService.snapshot()).map(({ key, value }) => [key, value]));
    const context: ProjectionContext = { ...loaded, actor, role, now: new Date(), settings };
    if (role === 'staff') return staffProjection(context);
    if (role === 'provider') return providerProjection(context);
    return customerProjection(context);
  }

  async activity(user: RequestUser, id: string, query: RequestActivityQueryDto) {
    const actor = await this.actors.resolve(user.id);
    if (!actor.staff || actor.staff.status !== 'active') {
      throw new AppError(403, 'FORBIDDEN', actor.staff ? 'Your staff account is not active.' : 'This action is not available for your account type.');
    }
    const loaded = await this.loader.load(this.prisma, id);
    if (!loaded) throw this.notFound();
    const { skip, take } = paginationArgs(query.page, 20);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where: { entityType: 'service_request', entityId: loaded.row.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where: { entityType: 'service_request', entityId: loaded.row.id } }),
    ]);
    const canSeeContact = actor.staff.permissions.has('view.customer_contact');
    const canSeePricing = actor.staff.permissions.has('view.pricing');
    return toPaginatedResult(rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType,
      actorId: row.actorId,
      at: row.createdAt,
      metadata: safeAuditMetadata(row.metadata, canSeeContact, canSeePricing),
    })), total, query.page, 20);
  }

  private canSee(snapshot: NonNullable<Awaited<ReturnType<RequestSnapshotLoader['load']>>>['snapshot'], actor: Awaited<ReturnType<ActorService['resolve']>>) {
    if (actor.kind === 'staff' && actor.staff?.status === 'active') return true;
    if (snapshot.ownerId === actor.userId) return true;
    return actor.platformRoles.includes('provider') && snapshot.accessibleProviderUserIds?.includes(actor.userId ?? '') === true;
  }

  private isNextActor(snapshot: NonNullable<Awaited<ReturnType<RequestSnapshotLoader['load']>>>['snapshot'], actor: Awaited<ReturnType<ActorService['resolve']>>, now: Date): boolean {
    const next = nextActor(snapshot, deriveStage(snapshot, now), now);
    if (next === 'customer') return actor.platformRoles.includes('customer') && actor.userId === snapshot.ownerId;
    if (next === 'provider') return actor.platformRoles.includes('provider') && snapshot.currentProviderUserId === actor.userId;
    if (next.startsWith('staff:')) {
      const permission = next.slice('staff:'.length) as StaffPermission;
      return actor.kind === 'staff' && actor.staff?.status === 'active' && actor.staff.permissions.has(permission);
    }
    return false;
  }

  private matchesSearch(
    number: number,
    title: string,
    snapshot: NonNullable<Awaited<ReturnType<RequestSnapshotLoader['load']>>>['snapshot'],
    actor: Awaited<ReturnType<ActorService['resolve']>>,
    query: string,
    staff: boolean,
  ): boolean {
    const parsed = parseRequestId(query);
    if (parsed !== null && parsed === number) return true;
    const ownsRequest = snapshot.ownerId === actor.userId;
    const hasAcceptedAssignment = snapshot.currentProviderUserId === actor.userId &&
      (snapshot.currentAssignment?.status === 'accepted' || snapshot.currentAssignment?.status === 'completed');
    return (staff || ownsRequest || hasAcceptedAssignment) && title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }

  private notFound() {
    return new AppError(404, 'NOT_FOUND', OPAQUE_MESSAGE);
  }
}

function safeAuditMetadata(value: Prisma.JsonValue | null, canSeeContact: boolean, canSeePricing: boolean): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => safeAuditMetadata(item, canSeeContact, canSeePricing));
  const record = value as Record<string, Prisma.JsonValue>;
  const field = typeof record.field === 'string' ? record.field.toLowerCase() : '';
  if (!canSeeContact && /phone|address|contact|access|customername/.test(field)) return null;
  if (!canSeePricing && /budget|amount|total|price|rate|payout|contribution|margin|payment|refund/.test(field)) return null;
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) => {
    const normalized = key.toLowerCase();
    if (normalized === 'note') return [];
    if (!canSeeContact && /phone|address|contactmethod|access|customername/.test(normalized)) return [];
    if (!canSeePricing && /budget|amount|total|price|rate|payout|contribution|margin|payment|refund/.test(normalized)) return [];
    return [[key, safeAuditMetadata(item, canSeeContact, canSeePricing)]];
  }));
}
