import type { CommandContext } from './command-runner';

/** Money approval items outlive a cancellation: Finance still decides refunds, payouts and offline payments (05). */
export const MONEY_APPROVAL_KINDS: ReadonlyArray<string> = [
  'refund',
  'payout',
  'payout_second',
  'offline_payment',
];

/** Items that only make sense for the provider currently on the job; withdrawing or replacing the provider closes them. */
export const PROVIDER_BOUND_APPROVAL_KINDS: ReadonlyArray<string> = [
  'quote_build',
  'quote_approval',
  'schedule_needed',
  'schedule_change',
  'no_show',
  'progress',
  'blocker',
  'completion',
];

/**
 * Closes the open approval items of the given kinds for the request (02 §6.11:
 * the clock stops when the item is decided, withdrawn or made irrelevant).
 * Items opened earlier in the same command are not visible yet, so a command
 * that opens and closes the same kind calls `ctx.approvals.close` itself.
 */
export async function closeOpenApprovals(
  ctx: Pick<CommandContext, 'tx' | 'snap' | 'approvals'>,
  kinds: ReadonlyArray<string>,
  reason: string,
): Promise<void> {
  const open = await ctx.tx.approvalDeadline.findMany({
    where: { requestId: ctx.snap.id, closedAt: null, kind: { in: [...kinds] } },
    select: { kind: true, itemId: true },
  });
  for (const item of open) ctx.approvals.close(item.kind, item.itemId, reason);
}

/**
 * Closes every approval deadline still open for the request (02 §6.11, plan C.5),
 * after any command-specific open or close. `keep` lists kinds that stay open.
 */
export async function closeRequestApprovals(
  ctx: Pick<CommandContext, 'tx' | 'snap' | 'approvals'>,
  reason: string,
  keep: ReadonlyArray<string> = [],
): Promise<void> {
  const open = await ctx.tx.approvalDeadline.findMany({
    where: { requestId: ctx.snap.id, closedAt: null },
    select: { kind: true, itemId: true },
  });
  for (const item of open)
    if (!keep.includes(item.kind))
      ctx.approvals.close(item.kind, item.itemId, reason);
}

/** A request that ends (rejected, cancelled, closed) keeps only the money items Finance still has to decide. */
export const closeEndedRequestApprovals = (
  ctx: Pick<CommandContext, 'tx' | 'snap' | 'approvals'>,
  reason: string,
): Promise<void> => closeRequestApprovals(ctx, reason, MONEY_APPROVAL_KINDS);
