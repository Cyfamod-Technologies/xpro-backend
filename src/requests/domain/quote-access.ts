type AssignmentAccessRow = {
  id: string;
  providerUserId: string;
  status: string;
  reviewedAt?: Date | null;
};

const HELD_STATUSES = new Set(['accepted', 'completed', 'replaced']);

/**
 * The provider's assignments on a request that staff confirmed (04 §10): the
 * current one and earlier ones that were replaced or withdrawn after
 * confirmation. Offers, declines and unconfirmed assignments never count, so
 * a stranger gets no quote access (B-01, E-26).
 */
export function confirmedAssignmentIds(
  assignments: readonly AssignmentAccessRow[],
  userId: string,
): string[] {
  return assignments
    .filter(
      (item) =>
        item.providerUserId === userId &&
        (HELD_STATUSES.has(item.status) ||
          (item.status === 'withdrawn' && !!item.reviewedAt)),
    )
    .map((item) => item.id);
}
