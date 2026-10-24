import {
  dayAvailability,
  type TimeOff,
  type WorkingHours,
} from '../../platform/calendar/provider-calendar';

export type DispatchRequest = {
  id: string;
  ownerId: string;
  service: string;
  skill?: string | null;
  districtId: string;
  districtName: string;
  cityId: string;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
};

export type DispatchProvider = {
  id: string;
  userId: string;
  name: string;
  verification: string;
  userStatus: string;
  delisted: boolean;
  services: readonly string[];
  skills: Readonly<Record<string, readonly string[]>>;
  serviceAreaIds: readonly string[];
  cityId: string | null;
  available: boolean;
  capacity: number;
  committedJobs: number;
  workingHours: WorkingHours;
  timeOff: readonly TimeOff[];
  hasVerifiedCurrentBank: boolean;
  lastOfferedAt: Date | null;
  experience: number;
  reliability: { offers: number; declines: number; expiries: number; noShows: number };
  earlierEndReasons: readonly string[];
};

export type EligibilityRule = 'verification' | 'standing' | 'conflict' | 'service' | 'available' | 'area' | 'day' | 'skill' | 'capacity' | 'previous' | 'bank';
export type EligibilityResult = { eligible: true } | { eligible: false; rule: EligibilityRule; reason: string };

export const OVERRIDABLE_RULES: readonly EligibilityRule[] = ['area', 'day', 'skill', 'capacity', 'previous', 'bank'];

const exclusion = (rule: EligibilityRule, reason: string): EligibilityResult => ({ eligible: false, rule, reason });

export function evaluateEligibility(
  provider: DispatchProvider,
  request: DispatchRequest,
  options: { requireVerifiedBank: boolean },
): EligibilityResult {
  if (provider.verification !== 'approved' && provider.verification !== 'delisted') return exclusion('verification', 'Not verified');
  if (provider.userStatus === 'suspended') return exclusion('standing', 'Suspended');
  if (provider.delisted) return exclusion('standing', 'Delisted');
  if (provider.userId === request.ownerId) return exclusion('conflict', 'Own request');
  if (!provider.services.includes(request.service)) return exclusion('service', `Doesn’t offer ${request.service}`);
  if (!provider.available) return exclusion('available', 'Not accepting new jobs');

  if (!provider.serviceAreaIds.includes(request.districtId) && provider.cityId !== request.cityId)
    return exclusion('area', `Doesn’t cover ${request.districtName}`);

  const start = request.effectiveStartDate;
  if (start) {
    const availability = dayAvailability(provider.workingHours, provider.timeOff, start);
    if (!availability.available) {
      if (availability.reason === 'time_off' && request.service === 'Hire' && request.effectiveEndDate) {
        const conflict = provider.timeOff.find((item) => item.from <= request.effectiveEndDate! && item.to >= start);
        if (conflict) return exclusion('day', `On time off during the hire (${conflict.from} to ${conflict.to})`);
      }
      if (availability.reason === 'time_off') return exclusion('day', `On time off on ${start}`);
      const date = new Date(`${start}T12:00:00+01:00`);
      return exclusion('day', `Doesn’t work on ${new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'Africa/Lagos' }).format(date)}s`);
    }
    if (request.service === 'Hire' && request.effectiveEndDate) {
      const spanOff = provider.timeOff.find((item) => item.from <= request.effectiveEndDate! && item.to >= start);
      if (spanOff) return exclusion('day', `On time off during the hire (${spanOff.from} to ${spanOff.to})`);
    }
  }

  if (request.skill && !(provider.skills[request.service] ?? []).includes(request.skill))
    return exclusion('skill', `Doesn’t offer ${request.skill}`);
  if (provider.committedJobs >= provider.capacity)
    return exclusion('capacity', `At capacity (${provider.committedJobs} of ${provider.capacity} jobs)`);
  if (provider.earlierEndReasons.length) {
    const reasonByEnd: Record<string, string> = {
      declined: 'Declined earlier', expired: 'Offer expired earlier',
      not_confirmed: 'Not confirmed earlier', withdrawn: 'Withdrawn earlier', replaced: 'Replaced earlier',
    };
    const reason = reasonByEnd[provider.earlierEndReasons[0]!];
    if (reason) return exclusion('previous', reason);
  }
  if (options.requireVerifiedBank && !provider.hasVerifiedCurrentBank)
    return exclusion('bank', 'Bank details not verified');
  return { eligible: true };
}
