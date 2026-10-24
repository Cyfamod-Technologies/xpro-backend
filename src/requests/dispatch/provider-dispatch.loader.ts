import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { DispatchProvider } from '../domain/eligibility';
import type { TimeOff } from '../../platform/calendar/provider-calendar';

const COMMITTED_REQUEST_STATUSES = new Set([
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
]);
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

  async list(now: Date, requestId: string): Promise<DispatchProvider[]> {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const profiles = await this.prisma.providerProfile.findMany({
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, status: true },
        },
        bankAccounts: { where: { state: 'verified' }, select: { id: true } },
      },
    });
    const profileIds = profiles.map(({ id }) => id);
    const [assignments, events] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { providerId: { in: profileIds } },
        include: { request: { select: { id: true, status: true } } },
      }),
      this.prisma.providerReliabilityEvent.findMany({
        where: { providerId: { in: profileIds }, occurredAt: { gte: since } },
      }),
    ]);
    return profiles.map((profile) => {
      const providerAssignments = assignments.filter(
        ({ providerId }) => providerId === profile.id,
      );
      const committedJobs = new Set(
        providerAssignments
          .filter(
            (assignment) =>
              assignment.requestId !== requestId &&
              (assignment.status === 'offered' ||
                assignment.status === 'pending_approval' ||
                (assignment.status === 'accepted' &&
                  COMMITTED_REQUEST_STATUSES.has(assignment.request.status))),
          )
          .map(({ requestId }) => requestId),
      ).size;
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
      const skills = Object.fromEntries(
        Object.entries(object(profile.skills)).map(([key, value]) => [
          key,
          strings(value),
        ]),
      );
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
        delisted: profile.verification === 'delisted',
        services: strings(profile.services),
        skills,
        serviceAreaIds: areas,
        cityId: profile.cityId,
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
