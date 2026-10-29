import type { VerifiedTransaction } from '../payment-gateway';

export type PaymentToMatch = {
  id: string;
  reference: string;
  amount: bigint;
  requestId: string;
  quoteId: string;
};

export type TransactionMatch =
  { matches: true } | { matches: false; reason: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Paystack returns metadata as an object, but sometimes as a JSON string. */
const metadataRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
};

/**
 * 05 §6.2: a verified transaction settles a payment only when status,
 * reference, exact kobo amount, NGN, the owner's email and our own metadata
 * all agree. Anything else is quarantined, never ignored (05 §7).
 */
export function compareTransaction(
  verified: VerifiedTransaction,
  payment: PaymentToMatch,
  ownerEmail: string | null,
): TransactionMatch {
  const metadata = metadataRecord(verified.metadata);
  if (verified.status !== 'success')
    return { matches: false, reason: 'The transaction was not successful.' };
  if (verified.reference !== payment.reference)
    return { matches: false, reason: 'The transaction reference differs.' };
  if (verified.amount !== Number(payment.amount))
    return { matches: false, reason: 'The transaction amount differs.' };
  if (verified.currency !== 'NGN')
    return { matches: false, reason: 'The transaction currency is not NGN.' };
  if (
    !ownerEmail ||
    verified.customer?.email?.toLowerCase() !== ownerEmail.toLowerCase()
  )
    return { matches: false, reason: 'The customer email differs.' };
  if (
    metadata.paymentId !== payment.id ||
    metadata.requestId !== payment.requestId ||
    metadata.quoteId !== payment.quoteId
  )
    return { matches: false, reason: 'The transaction metadata differs.' };
  return { matches: true };
}

export const matches = (
  verified: VerifiedTransaction,
  payment: PaymentToMatch,
  ownerEmail: string | null,
): boolean => compareTransaction(verified, payment, ownerEmail).matches;
