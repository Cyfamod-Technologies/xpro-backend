import { invalid } from './guards/common';
import type { GuardFailure } from './guards/types';

export type QuoteLine = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export const LINE_ITEMS_MESSAGE =
  'Add a description, positive quantity and unit price for every line item.';
export const QUOTE_TOTAL_MESSAGE = 'The quote total is too large.';

function isValidLine(item: unknown): item is QuoteLine {
  if (typeof item !== 'object' || item === null) return false;
  const { description, quantity, unitPrice } = item as Partial<
    Record<keyof QuoteLine, unknown>
  >;
  return (
    typeof description === 'string' &&
    description.trim().length > 0 &&
    typeof quantity === 'number' &&
    typeof unitPrice === 'number' &&
    Number.isSafeInteger(quantity) &&
    Number.isSafeInteger(unitPrice) &&
    quantity > 0 &&
    unitPrice > 0
  );
}

/** The kobo total of a quote or costing, or the 04 §6.10/§6.11 line-item failure. */
export function quoteItemsTotal(
  items: unknown,
): { ok: true; total: bigint } | GuardFailure {
  if (!Array.isArray(items) || !items.length || !items.every(isValidLine))
    return invalid(LINE_ITEMS_MESSAGE);
  const total = items.reduce(
    (sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitPrice),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    return invalid(QUOTE_TOTAL_MESSAGE);
  return { ok: true, total };
}
