import {
  dayAvailability,
  type TimeOff,
  type WorkingHours,
} from '../../platform/calendar/provider-calendar';
import { providerBlocked } from './provider-standing';

export type DispatchRequest = {
  id: string;
  ownerId: string;
  service: string;
  skill?: string | null;
  districtId: string;
  districtName: string;
  cityId: string;
  cityName?: string | null;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
};

export type DispatchProvider = {
  id: string;
  userId: string;
  name: string;
  /** `delisted` is the provider profile's own verification status (03 §4.1). */
  verification: string;
  userStatus: string;
  /** 03 §4.1 `reliability_status`; `restricted` blocks new offers. */
  reliabilityStatus: string;
  services: readonly string[];
  skills: Readonly<Record<string, readonly string[]>>;
  /** District and city ids the provider covers; a city id covers every district in it (04 §4.3). */
  serviceAreaIds: readonly string[];
  available: boolean;
  capacity: number;
  committedJobs: number;
  workingHours: WorkingHours;
  timeOff: readonly TimeOff[];
  hasVerifiedCurrentBank: boolean;
  lastOfferedAt: Date | null;
  experience: number;
  reliability: {
    offers: number;
    declines: number;
    expiries: number;
    noShows: number;
  };
  earlierEndReasons: readonly string[];
};

export type EligibilityRule =
  | 'verification'
  | 'standing'
  | 'conflict'
  | 'service'
  | 'available'
  | 'area'
  | 'day'
  | 'skill'
  | 'capacity'
  | 'previous'
  | 'bank';
export type EligibilityFailure = { rule: EligibilityRule; reason: string };
export type EligibilityResult =
  { eligible: true } | ({ eligible: false } & EligibilityFailure);
export type EligibilityOptions = { requireVerifiedBank: boolean };

export const OVERRIDABLE_RULES: readonly EligibilityRule[] = [
  'area',
  'day',
  'skill',
  'capacity',
  'previous',
  'bank',
];

const failure = (
  rule: EligibilityRule,
  reason: string,
): EligibilityFailure => ({
  rule,
  reason,
});

type Check = (
  provider: DispatchProvider,
  request: DispatchRequest,
  options: EligibilityOptions,
) => EligibilityFailure | null;

const STANDING_REASONS = {
  suspended: 'Suspended',
  delisted: 'Delisted',
  // new message: not in spec
  restricted: 'Restricted',
} as const;

const REASON_BY_END: Record<string, string> = {
  declined: 'Declined earlier',
  expired: 'Offer expired earlier',
  not_confirmed: 'Not confirmed earlier',
  withdrawn: 'Withdrawn earlier',
  replaced: 'Replaced earlier',
};

const verificationCheck: Check = (provider) =>
  provider.verification !== 'approved' && provider.verification !== 'delisted'
    ? failure('verification', 'Not verified')
    : null;

const standingCheck: Check = (provider) => {
  const standing = providerBlocked({
    userStatus: provider.userStatus,
    verification: provider.verification,
    reliabilityStatus: provider.reliabilityStatus,
  });
  return standing.reason
    ? failure('standing', STANDING_REASONS[standing.reason])
    : null;
};

const conflictCheck: Check = (provider, request) =>
  provider.userId === request.ownerId
    ? failure('conflict', 'Own request')
    : null;

const serviceCheck: Check = (provider, request) =>
  provider.services.includes(request.service)
    ? null
    : failure('service', `Doesn’t offer ${request.service}`);

const availableCheck: Check = (provider) =>
  provider.available ? null : failure('available', 'Not accepting new jobs');

// 04 §6.5 E6: the request's district or its city is in `serviceAreaIds`.
const areaCheck: Check = (provider, request) =>
  provider.serviceAreaIds.includes(request.districtId) ||
  provider.serviceAreaIds.includes(request.cityId)
    ? null
    : failure('area', `Doesn’t cover ${request.districtName}`);

const dayCheck: Check = (provider, request) => {
  const start = request.effectiveStartDate;
  if (!start) return null;
  const end = request.service === 'Hire' ? request.effectiveEndDate : null;
  const availability = dayAvailability(
    provider.workingHours,
    provider.timeOff,
    start,
  );
  if (!availability.available) {
    if (availability.reason === 'time_off' && end) {
      const conflict = provider.timeOff.find(
        (item) => item.from <= end && item.to >= start,
      );
      if (conflict)
        return failure(
          'day',
          `On time off during the hire (${conflict.from} to ${conflict.to})`,
        );
    }
    if (availability.reason === 'time_off')
      return failure('day', `On time off on ${start}`);
    const date = new Date(`${start}T12:00:00+01:00`);
    return failure(
      'day',
      `Doesn’t work on ${new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'Africa/Lagos' }).format(date)}s`,
    );
  }
  if (end) {
    const spanOff = provider.timeOff.find(
      (item) => item.from <= end && item.to >= start,
    );
    if (spanOff)
      return failure(
        'day',
        `On time off during the hire (${spanOff.from} to ${spanOff.to})`,
      );
  }
  return null;
};

const skillCheck: Check = (provider, request) =>
  request.skill &&
  !(provider.skills[request.service] ?? []).includes(request.skill)
    ? failure('skill', `Doesn’t offer ${request.skill}`)
    : null;

const capacityCheck: Check = (provider) =>
  provider.committedJobs >= provider.capacity
    ? failure(
        'capacity',
        `At capacity (${provider.committedJobs} of ${provider.capacity} jobs)`,
      )
    : null;

const previousCheck: Check = (provider) => {
  const reason = REASON_BY_END[provider.earlierEndReasons[0] ?? ''];
  return reason ? failure('previous', reason) : null;
};

const bankCheck: Check = (provider, _request, options) =>
  options.requireVerifiedBank && !provider.hasVerifiedCurrentBank
    ? failure('bank', 'Bank details not verified')
    : null;

/** 04 §6.5 E1 to E11, in the spec's order. */
const CHECKS: readonly Check[] = [
  verificationCheck,
  standingCheck,
  conflictCheck,
  serviceCheck,
  availableCheck,
  areaCheck,
  dayCheck,
  skillCheck,
  capacityCheck,
  previousCheck,
  bankCheck,
];

/** The first failing rule, as recorded in a `DispatchRun` exclusion. */
export function evaluateEligibility(
  provider: DispatchProvider,
  request: DispatchRequest,
  options: EligibilityOptions,
): EligibilityResult {
  for (const check of CHECKS) {
    const found = check(provider, request, options);
    if (found) return { eligible: false, ...found };
  }
  return { eligible: true };
}

/**
 * Every failing rule in E1 to E11 order, not only the first. A manual offer
 * and the review re-check need all of them (04 §6.6, §6.9).
 */
export function evaluateAll(
  provider: DispatchProvider,
  request: DispatchRequest,
  options: EligibilityOptions,
): EligibilityFailure[] {
  return CHECKS.flatMap((check) => {
    const found = check(provider, request, options);
    return found ? [found] : [];
  });
}
