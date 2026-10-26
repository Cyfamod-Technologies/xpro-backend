import type { Job } from 'bullmq';
import { TimerRegistry } from './timer-registry';
import { TimersProcessor } from './timers.processor';

function build() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    requestTimer: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const registry = new TimerRegistry();
  const processor = new TimersProcessor(prisma as never, registry, {} as never);
  const sweep = () =>
    processor.process({ name: 'timers.sweep', data: {} } as Job<{
      timerId?: string;
    }>);
  return { registry, sweep };
}

describe('TimersProcessor sweepers', () => {
  it('runs every registered sweeper on each sweep', async () => {
    const { registry, sweep } = build();
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);
    registry.registerSweeper(first);
    registry.registerSweeper(second);

    await sweep();

    expect(first).toHaveBeenCalledWith(expect.any(Date));
    expect(second).toHaveBeenCalledWith(expect.any(Date));
  });

  it('keeps sweeping after one sweeper throws', async () => {
    const { registry, sweep } = build();
    const after = jest.fn().mockResolvedValue(undefined);
    registry.registerSweeper(() => Promise.reject(new Error('boom')));
    registry.registerSweeper(after);

    await expect(sweep()).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledTimes(1);
  });
});
