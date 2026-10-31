import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { ActorService } from '../platform/actor/actor.service';
import { loadCatalog } from '../platform/catalog/catalog.tree';
import type { CatalogIndex } from '../platform/catalog/catalog.types';
import {
  namesFromIds,
  profileSkillIds,
} from '../platform/catalog/provider-skills';
import { PrismaService } from '../prisma/prisma.service';
import type { StaffPermission } from '../staff/staff-permissions';
import { StorageService } from '../storage/storage.service';
import { FeaturedProvidersUpdateDto } from './dto/featured-providers.dto';

export const FEATURED_PROVIDER_LIMIT = 12;
export const NO_SHOW_WINDOW_DAYS = 90;
export const MIN_BIO_LENGTH = 40;
const BIO_CARD_LIMIT = 220;
const PHOTO_URL_TTL_SECONDS = 3600;
const DAY_MS = 24 * 60 * 60 * 1000;

const FEATURED_DENIED =
  'You do not have permission to manage featured providers.';

export type IneligibleReason =
  | 'not_approved'
  | 'inactive_account'
  | 'reliability_review'
  | 'recent_no_show'
  | 'incomplete_profile';

export type FeaturedSource = 'pinned' | 'default';

/** Everything `buildFeaturedList` needs to know about one provider. */
export interface FeaturedCandidate {
  id: string;
  trade: string;
  completedJobs: number;
  lastActiveAt: Date;
  ineligibleReasons: readonly string[];
  mode: 'pinned' | 'hidden' | null;
  position: number | null;
}

export interface FeaturedSelection {
  id: string;
  source: FeaturedSource;
}

/** Public projection. Deliberately has no contact, bank, document, user-id or review fields. */
export interface FeaturedProviderCard {
  id: string;
  displayName: string;
  trade: string;
  services: string[];
  city: string;
  areas: string[];
  photoUrl: string | null;
  bio: string;
  completedJobs: number;
  experienceYears: number;
}

export interface AdminFeaturedRow {
  providerId: string;
  name: string;
  businessName: string | null;
  trade: string;
  city: string;
  completedJobs: number;
  eligible: boolean;
  ineligibleReasons: string[];
}

export interface AdminFeaturedState {
  revision: string;
  limit: number;
  pinned: AdminFeaturedRow[];
  hidden: AdminFeaturedRow[];
  preview: Array<FeaturedProviderCard & { source: FeaturedSource }>;
  candidates: AdminFeaturedRow[];
}

const PROFILE_SELECT = {
  id: true,
  userId: true,
  trade: true,
  location: { select: { name: true } },
  services: true,
  serviceIds: true,
  skills: true,
  skillIds: true,
  serviceAreaIds: true,
  businessName: true,
  bio: true,
  photo: true,
  experience: true,
  verification: true,
  reliabilityStatus: true,
  reviewedAt: true,
  createdAt: true,
  user: { select: { firstName: true, lastName: true, status: true } },
} satisfies Prisma.ProviderProfileSelect;

type ProfileRow = Prisma.ProviderProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

type LoadedProvider = FeaturedCandidate & {
  profile: ProfileRow;
  /** Names of the places the provider covers, in `serviceAreaIds` order. */
  areaNames: string[];
};

type FeaturedRow = {
  providerId: string;
  mode: 'pinned' | 'hidden';
  position: number | null;
  updatedAt: Date;
};

function photoId(photo: unknown): string | null {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) return null;
  const id = (photo as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function ineligibleReasonsFor(
  profile: Pick<
    ProfileRow,
    | 'verification'
    | 'reliabilityStatus'
    | 'bio'
    | 'trade'
    | 'location'
    | 'photo'
    | 'user'
  >,
  hasRecentNoShow: boolean,
): IneligibleReason[] {
  const reasons: IneligibleReason[] = [];
  if (profile.verification !== 'approved') reasons.push('not_approved');
  if (profile.user.status !== 'active') reasons.push('inactive_account');
  if (profile.reliabilityStatus === 'review_due')
    reasons.push('reliability_review');
  if (hasRecentNoShow) reasons.push('recent_no_show');
  if (
    !photoId(profile.photo) ||
    profile.bio.trim().length < MIN_BIO_LENGTH ||
    !profile.trade.trim() ||
    !profile.location?.name.trim()
  )
    reasons.push('incomplete_profile');
  return reasons;
}

function rankCompare(a: FeaturedCandidate, b: FeaturedCandidate): number {
  return (
    b.completedJobs - a.completedJobs ||
    b.lastActiveAt.getTime() - a.lastActiveAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Pure selection of the public featured list.
 * 1. hidden providers never appear;
 * 2. pinned providers lead in `position` order unless not approved / inactive;
 * 3. remaining slots go to default-eligible providers, ranked by completed jobs then recency,
 *    spread across trades (least-used trade first, pinned providers counted) so one trade cannot fill the list;
 * 4. capped at `limit`.
 */
export function buildFeaturedList(
  candidates: readonly FeaturedCandidate[],
  limit: number = FEATURED_PROVIDER_LIMIT,
): FeaturedSelection[] {
  const pinned = candidates
    .filter(
      (candidate) =>
        candidate.mode === 'pinned' &&
        !candidate.ineligibleReasons.includes('not_approved') &&
        !candidate.ineligibleReasons.includes('inactive_account'),
    )
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) -
          (b.position ?? Number.MAX_SAFE_INTEGER) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limit);

  const result: FeaturedSelection[] = pinned.map((candidate) => ({
    id: candidate.id,
    source: 'pinned',
  }));
  const slots = limit - result.length;
  if (slots <= 0) return result;

  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.mode === null && candidate.ineligibleReasons.length === 0,
    )
    .sort(rankCompare);

  const tradeKey = (candidate: FeaturedCandidate) =>
    candidate.trade.trim().toLowerCase();

  const groups = new Map<string, Array<{ rank: number; id: string }>>();
  ranked.forEach((candidate, rank) => {
    const key = tradeKey(candidate);
    const group = groups.get(key);
    if (group) group.push({ rank, id: candidate.id });
    else groups.set(key, [{ rank, id: candidate.id }]);
  });

  // Visible pinned providers already use up their trades' share of the spread.
  const counts = new Map<string, number>();
  for (const candidate of pinned) {
    const key = tradeKey(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lists = [...groups.entries()].map(([key, members]) => ({
    key,
    members,
    next: 0,
  }));
  for (let taken = 0; taken < slots; taken += 1) {
    let best: (typeof lists)[number] | null = null;
    for (const list of lists) {
      if (list.next >= list.members.length) continue;
      if (!best) {
        best = list;
        continue;
      }
      const count = counts.get(list.key) ?? 0;
      const bestCount = counts.get(best.key) ?? 0;
      if (
        count < bestCount ||
        (count === bestCount &&
          list.members[list.next].rank < best.members[best.next].rank)
      )
        best = list;
    }
    if (!best) break;
    result.push({ id: best.members[best.next].id, source: 'default' });
    best.next += 1;
    counts.set(best.key, (counts.get(best.key) ?? 0) + 1);
  }
  return result;
}

export function truncateBio(bio: string, max: number = BIO_CARD_LIMIT): string {
  const text = bio.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const room = max - 1; // leave space for the ellipsis
  const head = text.slice(0, room);
  let cut = head;
  if (text[room] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace > 0) cut = head.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}

export function displayNameFor(profile: {
  businessName: string | null;
  user: { firstName: string | null; lastName: string | null };
}): string {
  const business = profile.businessName?.trim();
  if (business) return business;
  const first = profile.user.firstName?.trim() ?? '';
  const last = profile.user.lastName?.trim() ?? '';
  if (!first) return last ? `${[...last][0].toUpperCase()}.` : 'XPro provider';
  return last ? `${first} ${[...last][0].toUpperCase()}.` : first;
}

function fullNameFor(profile: ProfileRow): string {
  return (
    [profile.user.firstName, profile.user.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ') || 'Unnamed provider'
  );
}

function revisionOf(count: number, maxUpdatedAt: Date | null | undefined) {
  return `${count}:${maxUpdatedAt?.toISOString() ?? '0'}`;
}

@Injectable()
export class FeaturedProvidersService {
  private readonly logger = new Logger(FeaturedProvidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogsService,
    private readonly actors: ActorService,
  ) {}

  async publicList(): Promise<{ providers: FeaturedProviderCard[] }> {
    const { providers } = await this.load();
    return { providers: await this.selectCards(providers) };
  }

  async adminState(userId: string): Promise<AdminFeaturedState> {
    await this.requirePermission(userId, 'provider.review');
    return this.buildAdminState();
  }

  async updateState(
    userId: string,
    dto: FeaturedProvidersUpdateDto,
  ): Promise<AdminFeaturedState> {
    await this.requirePermission(userId, 'provider.review');

    const aggregate = await this.prisma.featuredProvider.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    if (
      dto.revision !==
      revisionOf(aggregate._count._all, aggregate._max.updatedAt)
    )
      throw new ConflictException(
        'The featured list changed since you loaded it. Reload and try again.',
      );

    const pinned = dto.pinned;
    const hidden = dto.hidden;
    const all = [...pinned, ...hidden];
    if (new Set(all).size !== all.length)
      throw new BadRequestException(
        'A provider can only be listed once, either pinned or hidden.',
      );
    if (pinned.length > FEATURED_PROVIDER_LIMIT)
      throw new BadRequestException(
        `You can pin at most ${FEATURED_PROVIDER_LIMIT} providers.`,
      );

    if (all.length) {
      const existing = await this.prisma.providerProfile.findMany({
        where: { id: { in: all } },
        select: { id: true },
      });
      if (existing.length !== all.length)
        throw new BadRequestException('One or more providers do not exist.');
    }

    const operations: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.featuredProvider.deleteMany({}),
    ];
    if (pinned.length)
      operations.push(
        this.prisma.featuredProvider.createMany({
          data: pinned.map((providerId, position) => ({
            providerId,
            mode: 'pinned' as const,
            position,
            updatedBy: userId,
          })),
        }),
      );
    if (hidden.length)
      operations.push(
        this.prisma.featuredProvider.createMany({
          data: hidden.map((providerId) => ({
            providerId,
            mode: 'hidden' as const,
            position: null,
            updatedBy: userId,
          })),
        }),
      );
    await this.prisma.$transaction(operations);

    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'featured_providers',
      entityId: 'featured_providers',
      action: 'provider.featured.update',
      metadata: { pinned, hidden },
    });
    return this.buildAdminState();
  }

  private async buildAdminState(): Promise<AdminFeaturedState> {
    const { providers, rows } = await this.load();
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const toRow = (provider: LoadedProvider): AdminFeaturedRow => ({
      providerId: provider.id,
      name: fullNameFor(provider.profile),
      businessName: provider.profile.businessName?.trim() || null,
      trade: provider.trade,
      city: provider.profile.location?.name ?? '',
      completedJobs: provider.completedJobs,
      eligible: provider.ineligibleReasons.length === 0,
      ineligibleReasons: [...provider.ineligibleReasons],
    });
    const byName = (a: AdminFeaturedRow, b: AdminFeaturedRow) =>
      a.name.localeCompare(b.name) || a.providerId.localeCompare(b.providerId);
    const rowsFor = (mode: 'pinned' | 'hidden') =>
      rows
        .filter((row) => row.mode === mode)
        .sort(
          (a, b) =>
            (a.position ?? Number.MAX_SAFE_INTEGER) -
            (b.position ?? Number.MAX_SAFE_INTEGER),
        )
        .map((row) => byId.get(row.providerId))
        .filter((provider): provider is LoadedProvider => Boolean(provider))
        .map(toRow);

    const maxUpdatedAt = rows.reduce<Date | null>(
      (max, row) => (!max || row.updatedAt > max ? row.updatedAt : max),
      null,
    );
    const selection = buildFeaturedList(providers);
    const cards = await this.selectCards(providers, selection);
    const sources = new Map(selection.map((item) => [item.id, item.source]));

    return {
      revision: revisionOf(rows.length, maxUpdatedAt),
      limit: FEATURED_PROVIDER_LIMIT,
      pinned: rowsFor('pinned'),
      hidden: rowsFor('hidden').sort(byName),
      preview: cards.map((card) => ({
        ...card,
        source: sources.get(card.id) ?? 'default',
      })),
      candidates: providers
        .filter((provider) => provider.profile.verification === 'approved')
        .map(toRow)
        .sort(byName),
    };
  }

  /** Loads approved providers plus any provider that has a featured row (even if no longer approved). */
  private async load(): Promise<{
    providers: LoadedProvider[];
    rows: FeaturedRow[];
  }> {
    const rows = await this.prisma.featuredProvider.findMany({
      select: {
        providerId: true,
        mode: true,
        position: true,
        updatedAt: true,
      },
    });
    const rowById = new Map(rows.map((row) => [row.providerId, row]));
    const profiles = await this.prisma.providerProfile.findMany({
      where: {
        OR: [
          { verification: 'approved' },
          ...(rows.length
            ? [{ id: { in: rows.map((row) => row.providerId) } }]
            : []),
        ],
      },
      select: PROFILE_SELECT,
    });
    const ids = profiles.map((profile) => profile.id);

    const [stats, noShows] = ids.length
      ? await Promise.all([
          this.prisma.assignment.groupBy({
            by: ['providerId'],
            where: { status: 'completed', providerId: { in: ids } },
            _count: { _all: true },
            _max: { endedAt: true },
          }),
          this.prisma.noShow.findMany({
            where: {
              status: 'confirmed',
              providerId: { in: ids },
              decidedAt: {
                gte: new Date(Date.now() - NO_SHOW_WINDOW_DAYS * DAY_MS),
              },
            },
            select: { providerId: true },
            distinct: ['providerId'],
          }),
        ])
      : [[], []];
    const places = await this.prisma.location.findMany({
      where: {
        id: { in: [...new Set(profiles.flatMap((p) => p.serviceAreaIds))] },
      },
      select: { id: true, name: true },
    });
    const placeNames = new Map(places.map(({ id, name }) => [id, name]));
    const statsById = new Map(stats.map((stat) => [stat.providerId, stat]));
    const noShowIds = new Set(noShows.map((noShow) => noShow.providerId));

    const providers = profiles.map<LoadedProvider>((profile) => {
      const stat = statsById.get(profile.id);
      const row = rowById.get(profile.id);
      return {
        id: profile.id,
        trade: profile.trade,
        completedJobs: stat?._count._all ?? 0,
        lastActiveAt:
          stat?._max.endedAt ?? profile.reviewedAt ?? profile.createdAt,
        ineligibleReasons: ineligibleReasonsFor(
          profile,
          noShowIds.has(profile.id),
        ),
        mode: row?.mode ?? null,
        position: row?.position ?? null,
        profile,
        areaNames: profile.serviceAreaIds.flatMap((id) => {
          const name = placeNames.get(id);
          return name ? [name] : [];
        }),
      };
    });
    return { providers, rows };
  }

  private async selectCards(
    providers: LoadedProvider[],
    selection: FeaturedSelection[] = buildFeaturedList(providers),
  ): Promise<FeaturedProviderCard[]> {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const selected = selection
      .map((item) => byId.get(item.id))
      .filter((provider): provider is LoadedProvider => Boolean(provider));
    const [catalog, photoUrls] = await Promise.all([
      loadCatalog(this.prisma),
      this.photoUrls(selected.map((p) => p.profile)),
    ]);
    return selected.map((provider) =>
      this.toCard(provider, photoUrls, catalog),
    );
  }

  private toCard(
    provider: LoadedProvider,
    photoUrls: Map<string, string>,
    catalog: CatalogIndex,
  ): FeaturedProviderCard {
    const { profile } = provider;
    const { serviceIds, skillIds } = profileSkillIds(catalog, profile);
    return {
      id: profile.id,
      displayName: displayNameFor(profile),
      trade: profile.trade.trim(),
      services: namesFromIds(catalog, serviceIds, skillIds).services,
      city: profile.location?.name.trim() ?? '',
      areas: provider.areaNames,
      photoUrl: photoUrls.get(profile.id) ?? null,
      bio: truncateBio(profile.bio),
      completedJobs: provider.completedJobs,
      experienceYears: Math.max(0, Math.floor(profile.experience || 0)),
    };
  }

  /** Signed inline URLs for attached profile photos. Any failure just means "no photo". */
  private async photoUrls(
    profiles: ProfileRow[],
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const wanted = profiles.flatMap((profile) => {
      const id = photoId(profile.photo);
      return id ? [{ profile, id }] : [];
    });
    if (!wanted.length) return urls;
    try {
      const uploads = await this.prisma.providerUpload.findMany({
        where: {
          id: { in: wanted.map((item) => item.id) },
          purpose: 'provider_photo',
          status: 'attached',
        },
        select: { id: true, ownerId: true, storageKey: true },
      });
      const uploadById = new Map(uploads.map((upload) => [upload.id, upload]));
      await Promise.all(
        wanted.map(async ({ profile, id }) => {
          const upload = uploadById.get(id);
          if (!upload || upload.ownerId !== profile.userId) return;
          try {
            urls.set(
              profile.id,
              await this.storage.signedViewUrl(
                upload.storageKey,
                PHOTO_URL_TTL_SECONDS,
              ),
            );
          } catch (error) {
            this.logger.debug(
              `No photo URL for provider ${profile.id}: ${String(error)}`,
            );
          }
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Featured provider photos unavailable: ${String(error)}`,
      );
    }
    return urls;
  }

  private async requirePermission(userId: string, permission: StaffPermission) {
    requirePermission(await this.actors.resolve(userId), permission, {
      accountType: FEATURED_DENIED,
      inactive: FEATURED_DENIED,
      denied: FEATURED_DENIED,
    });
  }
}
