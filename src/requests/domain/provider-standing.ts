export type ProviderBlockReason = 'suspended' | 'delisted' | 'restricted';

export type ProviderStandingInput = {
  /** Account status of the provider's user. `null` means the user row is unavailable. */
  userStatus: string | null;
  verification: string | null;
  reliabilityStatus: string | null;
};

/**
 * A provider is blocked from new work when their account isn't active,
 * their profile is delisted (03 §4.1 verification) or their reliability
 * status is `restricted` (03 §4.1 reliability_status).
 */
export function providerBlocked({
  userStatus,
  verification,
  reliabilityStatus,
}: ProviderStandingInput): {
  blocked: boolean;
  reason: ProviderBlockReason | null;
} {
  if (userStatus !== null && userStatus !== 'active')
    return { blocked: true, reason: 'suspended' };
  if (verification === 'delisted') return { blocked: true, reason: 'delisted' };
  if (reliabilityStatus === 'restricted')
    return { blocked: true, reason: 'restricted' };
  return { blocked: false, reason: null };
}
