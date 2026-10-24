import { createHash } from 'node:crypto';
import type { DispatchProvider, DispatchRequest } from './eligibility';

export type DispatchWeights = { area: number; capacity: number; fairness: number; experience: number; reliability: number };
export type RankedProvider = { provider: DispatchProvider; total: number; factors: Record<keyof DispatchWeights, number> };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const fairHash = (requestId: string, providerId: string) => createHash('sha256').update(`${requestId}${providerId}`).digest('hex');

export function rankProviders(
  providers: readonly DispatchProvider[],
  request: DispatchRequest,
  weights: DispatchWeights,
  now: Date,
): RankedProvider[] {
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) throw new RangeError('At least one dispatch weight must be positive.');
  return providers.map((provider) => {
    const daysSinceOffer = provider.lastOfferedAt ? Math.max(0, (now.getTime() - provider.lastOfferedAt.getTime()) / 86_400_000) : Number.POSITIVE_INFINITY;
    const offers = provider.reliability.offers;
    const factors = {
      area: provider.serviceAreaIds.includes(request.districtId) ? 1 : provider.cityId === request.cityId ? 0.6 : 0,
      capacity: provider.capacity > 0 ? clamp01(1 - provider.committedJobs / provider.capacity) : 0,
      fairness: Number.isFinite(daysSinceOffer) ? Math.min(1, daysSinceOffer / 7) : 1,
      experience: Math.min(Math.max(provider.experience, 0), 20) / 20,
      reliability: offers < 5 ? 1 : clamp01(1 - (provider.reliability.declines + provider.reliability.expiries + provider.reliability.noShows) / offers),
    };
    const score = Object.keys(weights).reduce((sum, key) => sum + weights[key as keyof DispatchWeights] * factors[key as keyof DispatchWeights], 0);
    return { provider, total: Math.round((100 * score / totalWeight) * 100) / 100, factors };
  }).sort((a, b) => b.total - a.total || (a.provider.lastOfferedAt?.getTime() ?? -Infinity) - (b.provider.lastOfferedAt?.getTime() ?? -Infinity) || fairHash(request.id, a.provider.id).localeCompare(fairHash(request.id, b.provider.id)));
}
