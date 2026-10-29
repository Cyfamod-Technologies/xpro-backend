/** Request statuses in which an accepted assignment counts as a committed job (04 §6.5, Q-def-10). */
export const COMMITTED_REQUEST_STATUSES: ReadonlySet<string> = new Set([
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
]);

export type CommittedJobAssignment = {
  requestId: string;
  status: string;
  requestStatus: string;
};

/**
 * Capacity (04 §6.5 E9): the provider's assignments on **other** open
 * requests that are `offered` or `pending_approval`, plus `accepted` ones whose
 * request is `ready_to_schedule`, `scheduled`, `in_progress`, `blocked` or
 * `completion_pending`. Requests in `matched`, `quoted`, `awaiting_payment` and
 * `acknowledged` don't count. Counted per request, not per assignment.
 */
export function countCommittedJobs(
  assignments: readonly CommittedJobAssignment[],
  excludingRequestId: string,
): number {
  return new Set(
    assignments
      .filter(
        (assignment) =>
          assignment.requestId !== excludingRequestId &&
          (assignment.status === 'offered' ||
            assignment.status === 'pending_approval' ||
            (assignment.status === 'accepted' &&
              COMMITTED_REQUEST_STATUSES.has(assignment.requestStatus))),
      )
      .map(({ requestId }) => requestId),
  ).size;
}
