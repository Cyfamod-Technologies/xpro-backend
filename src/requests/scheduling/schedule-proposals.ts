import type { Prisma } from '@prisma/client';
import type { CommandContext } from '../command-runner';

/**
 * Cancels the request's open proposals (`proposed`, `changes_requested`) and
 * stops their T11 timers. Called when an approved `start` update puts the job
 * in execution: a proposal can no longer be confirmed (04 §6.13).
 */
export async function cancelOpenScheduleProposals(
  ctx: Pick<CommandContext, 'timers'> & { tx: Prisma.TransactionClient },
  requestId: string,
): Promise<void> {
  const open = await ctx.tx.schedule.findMany({
    where: {
      requestId,
      status: { in: ['proposed', 'changes_requested'] },
    },
    select: { id: true },
  });
  if (!open.length) return;
  await ctx.tx.schedule.updateMany({
    where: { id: { in: open.map((item) => item.id) } },
    data: { status: 'cancelled' },
  });
  for (const { id } of open)
    ctx.timers.stop(['T11.reminder24h', 'T11.staff48h'], id);
}
