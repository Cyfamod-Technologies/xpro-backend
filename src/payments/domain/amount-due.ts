export type CollectionRow = { amount: bigint; status: string };

const SETTLED = new Set(['paid', 'partially_refunded', 'refunded']);

/**
 * 05 §4.4: `amountDue = total − net settled collections`, where net is the
 * settled payments minus refunds that completed. It never goes below zero.
 */
export function amountDue(
  total: bigint,
  payments: readonly CollectionRow[],
  completedRefunds: bigint = 0n,
): bigint {
  const collected = payments
    .filter((payment) => SETTLED.has(payment.status))
    .reduce((sum, payment) => sum + payment.amount, 0n);
  const due = total - (collected - completedRefunds);
  return due > 0n ? due : 0n;
}
