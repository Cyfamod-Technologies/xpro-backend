import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { DispatchProvider } from '../domain/eligibility';
import { countCommittedJobs } from '../domain/committed-jobs';
import type { TimeOff } from '../../platform/calendar/provider-calendar';
import { loadCatalog } from '../../platform/catalog/catalog.tree';
import { profileSkillIds } from '../../platform/catalog/provider-skills';

/** The Prisma client or a transaction on it; a command passes its `tx` so the data is read inside the lock. */
type Db = PrismaService | Prisma.TransactionClient;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const timeOffEntries = (value: unknown): TimeOff[] =>
  Array.isArray(value)
    ? (value as unknown[]).filter(
        (item): item is TimeOff =>
          item !== null &&
          typeof item === 'object' &&
          'from' in item &&
          typeof item.from === 'string' &&
          'to' in item &&
          typeof item.to === 'string',
      )
    : [];

@Injectable()
export class ProviderDispatchLoader {
  constructor(private readonly prisma: PrismaService) {}

  list(
    now: Date,
    requestId: string,
    db: Db = this.prisma,
  ): Promise<DispatchProvider[]> {
    return this.load(db, now, requestId);
  }

  /** One provider, loaded fresh (used after `SELECT … FOR UPDATE` on the profile, 04 §6.6 capacity locking). */
  async one(
    providerId: string,
    now: Date,
    requestId: string,
    db: Db = this.prisma,
  ): Promise<DispatchProvider | null> {
    return (await this.load(db, now, requestId, providerId))[0] ?? null;
  }

  private async load(
    db: Db,
    now: Date,
    requestId: string,
    providerId?: string,
  ): Promise<DispatchProvider[]> {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const profiles = await db.providerProfile.findMany({
      ...(providerId ? { where: { id: providerId } } : {}),
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, status: true },
        },
        bankAccounts: { where: { state: 'verified' }, select: { id: true } },
      },
    });
    const profileIds = profiles.map(({ id }) => id);
    const [catalog, assignments, events] = await Promise.all([
      loadCatalog(db),
      db.assignment.findMany({
        where: { providerId: { in: profileIds } },
        include: { request: { select: { id: true, status: true } } },
      }),
      db.providerReliabilityEvent.findMany({
        where: { providerId: { in: profileIds }, occurredAt: { gte: since } },
      }),
    ]);
    return profiles.map((profile) => {
      const providerAssignments = assignments.filter(
        ({ providerId }) => providerId === profile.id,
      );
      const committedJobs = countCommittedJobs(
        providerAssignments.map((assignment) => ({
          requestId: assignment.requestId,
          status: assignment.status,
          requestStatus: assignment.request.status,
        })),
        requestId,
      );
      const providerEvents = events.filter(
        ({ providerId }) => providerId === profile.id,
      );
      const voided = new Set(
        providerEvents
          .filter(({ kind }) => kind === 'no_show_voided')
          .map(({ sourceId }) => sourceId.replace(/:voided$/, '')),
      );
      const reliabilityOffers = providerAssignments.filter(
        ({ offeredAt }) => offeredAt >= since,
      );
      const reliabilityEvents = providerEvents.filter(
        ({ kind, sourceId }) =>
          kind === 'declined' ||
          kind === 'expired' ||
          (kind === 'no_show_confirmed' && !voided.has(sourceId)),
      );
      const { serviceIds, skillIds } = profileSkillIds(catalog, profile);
      const providerName = [profile.user.firstName, profile.user.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const areas = strings(profile.serviceAreaIds);
      const timeOff = timeOffEntries(profile.timeOff);
      return {
        id: profile.id,
        userId: profile.userId,
        name: profile.businessName || providerName || profile.trade,
        verification: profile.verification,
        userStatus: profile.user.status,
        reliabilityStatus: profile.reliabilityStatus,
        serviceIds,
        skillIds,
        serviceAreaIds: areas,
        available: profile.available,
        capacity: profile.capacity,
        committedJobs,
        workingHours: object(profile.workingHours),
        timeOff,
        hasVerifiedCurrentBank: profile.bankAccounts.length > 0,
        lastOfferedAt: profile.lastOfferedAt,
        experience: profile.experience,
        reliability: {
          offers: reliabilityOffers.length,
          declines: reliabilityEvents.filter(({ kind }) => kind === 'declined')
            .length,
          expiries: reliabilityEvents.filter(({ kind }) => kind === 'expired')
            .length,
          noShows: reliabilityEvents.filter(
            ({ kind }) => kind === 'no_show_confirmed',
          ).length,
        },
        earlierEndReasons: providerAssignments
          .filter((assignment) => assignment.requestId === requestId)
          .flatMap(({ endReason }) => {
            if (endReason === 'acceptance_rejected') return ['not_confirmed'];
            if (endReason === 'withdrawn') return ['withdrawn'];
            if (endReason === 'replaced') return ['replaced'];
            return endReason === 'declined' || endReason === 'expired'
              ? [endReason]
              : [];
          }),
      };
    });
  }
}
