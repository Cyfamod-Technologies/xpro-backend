import type { EligibilityFailure, EligibilityRule } from './eligibility';
import { conflict, invalid, trimmed } from './guards/common';
import type { GuardFailure } from './guards/types';

/** E1, E2, E4 and E5 can never be overridden by a manual offer (04 §6.5). */
const NEVER_OVERRIDABLE: readonly EligibilityRule[] = [
  'verification',
  'standing',
  'service',
  'available',
];

export const OFFER_STALE_MESSAGE =
  'The ranked list is out of date. Refresh it and choose again.';
export const OFFER_NOT_APPROVED_MESSAGE =
  'Choose an approved, available provider for this service.';
export const OFFER_OWN_REQUEST_MESSAGE =
  "A provider can't be offered their own request.";
export const OFFER_NOTE_MESSAGE =
  'Add a note explaining why you chose this provider over the suggestion.';

export type ManualOfferAssessment =
  | { ok: true; overriddenRules: EligibilityRule[]; noteRequired: boolean }
  | GuardFailure;

/**
 * 04 §6.6 manual offer table, after the staleness check. `failures` is every
 * failing rule (`evaluateAll`). A note is required when the provider isn't the
 * run's top suggestion or fails any of E6 to E11; every failing rule is
 * recorded as overridden.
 */
export function assessManualOffer(input: {
  failures: readonly EligibilityFailure[];
  providerId: string;
  topSuggestionId: string | null;
  overrideNote?: string;
}): ManualOfferAssessment {
  const rules = input.failures.map(({ rule }) => rule);
  if (rules.some((rule) => NEVER_OVERRIDABLE.includes(rule)))
    return invalid(OFFER_NOT_APPROVED_MESSAGE);
  if (rules.includes('conflict')) return invalid(OFFER_OWN_REQUEST_MESSAGE);
  const noteRequired =
    rules.length > 0 || input.providerId !== input.topSuggestionId;
  if (noteRequired && !trimmed(input.overrideNote))
    return invalid(OFFER_NOTE_MESSAGE);
  return { ok: true, overriddenRules: rules, noteRequired };
}

/** Post-lock failure for a provider the run still listed as eligible (04 §6.6 "Capacity locking"). */
export const noLongerAvailableMessage = (
  providerName: string,
  reason: string,
) =>
  `${providerName} can no longer take this job (${reason}). Refresh the ranked list.`;

export const reviewNotApprovedMessage = (providerName: string) =>
  `${providerName} is no longer approved for this service. Reject the acceptance instead.`;

/** Rules the review re-check covers: E1 to E4 refuse, E5 to E8 and E11 need a note (04 §6.9). */
const REVIEW_REFUSED: readonly EligibilityRule[] = [
  'verification',
  'standing',
  'conflict',
  'service',
];
const REVIEW_NOTE_RULES: readonly EligibilityRule[] = [
  'available',
  'area',
  'day',
  'skill',
  'bank',
];

export type ReviewRecheck =
  | { ok: true; overriddenRules: EligibilityRule[]; overridden: boolean }
  | GuardFailure;

/**
 * 04 §6.9 re-check on approve. Capacity and previous aren't re-checked for the
 * provider's own offer, so E9 and E10 never appear in `failures` here.
 */
export function assessReviewRecheck(input: {
  providerName: string;
  failures: readonly EligibilityFailure[];
  overrideNote?: string;
}): ReviewRecheck {
  if (input.failures.some(({ rule }) => REVIEW_REFUSED.includes(rule)))
    return conflict(reviewNotApprovedMessage(input.providerName));
  const needsNote = input.failures.filter(({ rule }) =>
    REVIEW_NOTE_RULES.includes(rule),
  );
  if (!needsNote.length)
    return { ok: true, overriddenRules: [], overridden: false };
  if (!trimmed(input.overrideNote))
    return invalid(
      `Add a note to confirm this provider despite: ${needsNote.map(({ reason }) => reason).join('; ')}.`,
    );
  return {
    ok: true,
    overriddenRules: needsNote.map(({ rule }) => rule),
    overridden: true,
  };
}
