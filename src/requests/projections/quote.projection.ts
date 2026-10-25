import type { Contribution, Quote } from '@prisma/client';
import {
  itemsWithNumberMoney,
  itemsWithoutMoney,
  jsonArray,
  numberKobo,
} from './projection.helpers';

const LAST_EDITOR_BLOCK = 'You edited this quote last.';

export type CustomerQuoteView = {
  id: string;
  version: number;
  status: Quote['status'];
  items: Array<Record<string, unknown>>;
  total: number;
  note: string | null;
  validUntil: Date | null;
  publishedAt: Date | null;
  acceptedAt: Date | null;
  paymentDueAt: Date | null;
};

export type ProviderQuoteView = {
  id: string;
  version: number;
  status: Quote['status'];
  scope: Array<{ description: string; quantity: number }>;
  payoutAmount?: number;
};

export type StaffQuoteViewer = {
  canSeePricing: boolean;
  userId: string | null;
  canApprove: boolean;
  isSuperAdmin: boolean;
  payoutSuggestion?: number | null;
};

/** 04 §4.6 visibility: published fields and nothing internal. Money is a kobo number (A-23). */
export function customerQuoteView(row: Quote): CustomerQuoteView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    items: itemsWithNumberMoney(row.items),
    total: Number(row.total),
    note: row.note,
    validUntil: row.validUntil,
    publishedAt: row.publishedAt,
    acceptedAt: row.acceptedAt,
    paymentDueAt: row.paymentDueAt,
  };
}

/** Scope lines only, plus the payout of an assignment the provider holds (04 §10, 05). */
export function providerQuoteView(
  row: Quote,
  ownAssignmentIds: readonly string[],
): ProviderQuoteView {
  const ownPayout =
    row.payoutAmount !== null &&
    row.payoutAssignmentId !== null &&
    ownAssignmentIds.includes(row.payoutAssignmentId)
      ? Number(row.payoutAmount)
      : null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    scope: jsonArray(row.items).map((item) => ({
      description: typeof item.description === 'string' ? item.description : '',
      quantity: Number(item.quantity ?? 0),
    })),
    ...(ownPayout === null ? {} : { payoutAmount: ownPayout }),
  };
}

/** Every stored field staff need, with prices, notes and payout withheld unless the viewer holds `view.pricing`. */
export function staffQuoteView(row: Quote, viewer: StaffQuoteViewer) {
  const { canSeePricing } = viewer;
  const blocked =
    row.status === 'draft' &&
    row.approvalRequestedAt !== null &&
    viewer.canApprove &&
    !viewer.isSuperAdmin &&
    viewer.userId !== null &&
    row.lastEditedBy === viewer.userId;
  return {
    id: row.id,
    version: row.version,
    revision: row.revision,
    status: row.status,
    items: canSeePricing
      ? itemsWithNumberMoney(row.items)
      : itemsWithoutMoney(row.items),
    total: canSeePricing ? Number(row.total) : null,
    payoutAmount: canSeePricing ? numberKobo(row.payoutAmount) : null,
    amountsHidden: !canSeePricing,
    ...(canSeePricing
      ? {
          note: row.note,
          pricingOverrideNote: row.pricingOverrideNote,
          payoutAssignmentId: row.payoutAssignmentId,
          payoutSuggestion: viewer.payoutSuggestion ?? null,
        }
      : {}),
    basedOnAssignmentId: row.basedOnAssignmentId,
    lastEditedBy: row.lastEditedBy,
    approvalRequestedBy: row.approvalRequestedBy,
    approvalRequestedAt: row.approvalRequestedAt,
    approvedBy: row.approvedBy,
    selfApproved: row.selfApproved,
    returnedNote: row.returnedNote,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    validUntil: row.validUntil,
    respondedAt: row.respondedAt,
    responseNote: row.responseNote,
    acceptedAt: row.acceptedAt,
    paymentDueAt: row.paymentDueAt,
    providerChangedAt: row.providerChangedAt,
    blockedReason: blocked ? LAST_EDITOR_BLOCK : null,
  };
}

/** The quote the customer acts on: the highest published version that is awaiting a reply or payment. */
export const customerCurrentQuote = (rows: readonly Quote[]) =>
  rows.find((row) => row.status === 'sent' || row.status === 'accepted');

/** The provider's quote: the accepted one, else the one with the customer. */
export const providerCurrentQuote = (rows: readonly Quote[]) =>
  rows.find((row) => row.status === 'accepted') ??
  rows.find((row) => row.status === 'sent');

/** The default payout the form offers: the latest costing total for the current assignment (04 §5.3 `set_payout`). */
export function payoutSuggestion(
  contributions: ReadonlyArray<Pick<Contribution, 'assignmentId' | 'total'>>,
  assignmentId: string | null | undefined,
): number | null {
  if (!assignmentId) return null;
  const latest = contributions.find(
    (item) => item.assignmentId === assignmentId,
  );
  return latest ? Number(latest.total) : null;
}

type ContributionRow = Pick<
  Contribution,
  'providerId' | 'total' | 'items' | 'note'
>;

/** Staff see every costing; without `view.pricing` the rates and totals are withheld, not omitted (A-23). */
export function staffContributionView(
  row: ContributionRow,
  canSeePricing: boolean,
) {
  return canSeePricing
    ? {
        providerId: row.providerId,
        total: Number(row.total),
        items: itemsWithNumberMoney(row.items),
        note: row.note ?? '',
        amountsHidden: false,
      }
    : {
        providerId: row.providerId,
        total: null,
        items: itemsWithoutMoney(row.items),
        amountsHidden: true,
      };
}

export function providerContributionView(
  row: Pick<Contribution, 'items' | 'note'>,
) {
  return { items: itemsWithNumberMoney(row.items), note: row.note };
}
