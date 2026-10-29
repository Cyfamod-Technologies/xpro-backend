import { PrismaClient } from '@prisma/client';

/**
 * One-off clean-up for `dispatch.cascade` timers that failed during WP-2.5
 * testing (the request lock error) and would otherwise never run again.
 * Dry run by default; pass `--apply` to write. Refuses to run in production.
 */
const KIND = 'dispatch.cascade';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset timers when NODE_ENV=production.');
  }
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const failed = await prisma.requestTimer.findMany({
      where: { kind: KIND, status: 'failed' },
      orderBy: { createdAt: 'desc' },
    });
    const taken = new Set(
      (
        await prisma.requestTimer.findMany({
          where: { kind: KIND, status: 'pending' },
          select: { requestId: true, refId: true },
        })
      ).map((timer) => `${timer.requestId}:${timer.refId}`),
    );
    // request_timers_one_pending allows one pending row per (request, kind, ref): keep the newest failure.
    const resettable = failed.filter((timer) => {
      const key = `${timer.requestId}:${timer.refId}`;
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    });

    console.log(
      `${failed.length} failed ${KIND} timer(s); ${resettable.length} to reset, ${failed.length - resettable.length} skipped (a newer timer exists).`,
    );
    for (const timer of resettable)
      console.log(
        `  ${timer.id} request=${timer.requestId} attempts=${timer.attempts} error=${timer.lastError ?? '-'}`,
      );
    if (!apply) {
      console.log('Dry run. Re-run with --apply to reset them.');
      return;
    }
    let reset = 0;
    for (const timer of resettable) {
      const result = await prisma.requestTimer.updateMany({
        where: { id: timer.id, status: 'failed' },
        data: {
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          firedAt: null,
        },
      });
      reset += result.count;
    }
    console.log(`Reset ${reset} timer(s) to pending.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
