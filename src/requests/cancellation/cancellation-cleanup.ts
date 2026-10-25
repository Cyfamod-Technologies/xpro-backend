import type { CommandContext } from '../command-runner';

/**
 * Ends the accepted assignment on a cancelled request (04 §6.21): the
 * provider loses access, the assignment keeps its `workStarted` flag so
 * compensation can still be decided under 05 §6.4. Returns the ended
 * assignments so the caller can notify each provider.
 */
export async function endAcceptedAssignments(
  ctx: CommandContext,
  endedBy: string | null,
): Promise<Array<{ id: string; providerUserId: string }>> {
  const accepted = await ctx.tx.assignment.findMany({
    where: { requestId: ctx.snap.id, status: 'accepted' },
    select: { id: true, providerUserId: true },
  });
  if (!accepted.length) return [];
  await ctx.tx.assignment.updateMany({
    where: { id: { in: accepted.map(({ id }) => id) }, status: 'accepted' },
    data: {
      status: 'withdrawn',
      endReason: 'request_cancelled',
      endedAt: ctx.now,
      endedBy,
    },
  });
  return accepted;
}

/** Closes every approval deadline still open for the request (02 §6.11, plan C.5), after any command-specific open or close. */
export async function closeRequestApprovals(
  ctx: CommandContext,
  reason: string,
): Promise<void> {
  const open = await ctx.tx.approvalDeadline.findMany({
    where: { requestId: ctx.snap.id, closedAt: null },
    select: { kind: true, itemId: true },
  });
  for (const item of open) ctx.approvals.close(item.kind, item.itemId, reason);
}
