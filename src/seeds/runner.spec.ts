import type { PrismaClient } from '@prisma/client';
import { parseSeedArgs, runSeeds } from './runner';
import type { Seed } from './seed.types';

function fakePrisma(recorded: { version: number; checksum?: string } | null) {
  const upsert = jest.fn((_args: Record<string, unknown>) =>
    Promise.resolve({}),
  );
  const audit = jest.fn((_args: Record<string, unknown>) =>
    Promise.resolve({}),
  );
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    dataSeed: {
      findUnique: jest
        .fn()
        .mockResolvedValue(recorded && { name: 'demo', ...recorded }),
      upsert,
    },
    auditLog: { create: audit },
  };
  const prisma = {
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, upsert, audit };
}

const applyFn = () => jest.fn(() => Promise.resolve({ n: 1 }));

const demo = (version: number, apply = applyFn()): Seed => ({
  name: 'demo',
  version,
  checksum: 'new',
  apply,
});

const quiet = () => undefined;

describe('parseSeedArgs', () => {
  it('reads the flags and rejects anything else', () => {
    expect(parseSeedArgs(['--only=catalog', '--force', '--dry-run'])).toEqual({
      only: 'catalog',
      force: true,
      dryRun: true,
    });
    expect(() => parseSeedArgs(['--nope'])).toThrow('Unknown option');
  });
});

describe('runSeeds', () => {
  it('applies a seed that is not recorded and writes the ledger and an audit entry', async () => {
    const { prisma, upsert, audit } = fakePrisma(null);
    const seed = demo(2);
    const [report] = await runSeeds(prisma, [seed], {}, quiet);
    expect(report).toMatchObject({ status: 'applied', summary: { n: 1 } });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      create: { name: 'demo', version: 2, checksum: 'new' },
    });
    expect(audit.mock.calls[0][0]).toMatchObject({
      data: {
        actorType: 'system',
        entityType: 'seed',
        action: 'seed.applied',
      },
    });
  });

  it('skips a seed already recorded at its version or above', async () => {
    const { prisma, upsert } = fakePrisma({ version: 2, checksum: 'new' });
    const apply = applyFn();
    const [report] = await runSeeds(prisma, [demo(2, apply)], {}, quiet);
    expect(report).toMatchObject({ status: 'skipped', recordedVersion: 2 });
    expect(apply).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('warns when the data changed without a version bump', async () => {
    const { prisma } = fakePrisma({ version: 2, checksum: 'old' });
    const log = jest.fn();
    await runSeeds(prisma, [demo(2)], {}, log);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('bump the version'),
    );
  });

  it('applies a newer version, and --force re-applies the recorded one without lowering it', async () => {
    const newer = fakePrisma({ version: 1 });
    expect((await runSeeds(newer.prisma, [demo(2)], {}, quiet))[0].status).toBe(
      'applied',
    );
    const forced = fakePrisma({ version: 3 });
    const seed = demo(2);
    const [report] = await runSeeds(
      forced.prisma,
      [seed],
      { force: true },
      quiet,
    );
    expect(report.status).toBe('applied');
    expect(forced.upsert.mock.calls[0][0]).toMatchObject({
      create: { version: 3 },
    });
  });

  it('rolls back and writes nothing on --dry-run', async () => {
    const { prisma, upsert, audit } = fakePrisma(null);
    const [report] = await runSeeds(prisma, [demo(1)], { dryRun: true }, quiet);
    expect(report).toMatchObject({ status: 'dry-run', summary: { n: 1 } });
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('runs only the named seed and rejects an unknown name', async () => {
    const { prisma } = fakePrisma(null);
    const applied = applyFn();
    const skipped = applyFn();
    const first = demo(1, applied);
    const other: Seed = { ...demo(1, skipped), name: 'other' };
    await runSeeds(prisma, [first, other], { only: 'demo' }, quiet);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
    await expect(
      runSeeds(prisma, [first], { only: 'nope' }, quiet),
    ).rejects.toThrow('No seed called "nope". Available: demo.');
  });

  it('propagates a failing seed so the command exits non-zero', async () => {
    const { prisma } = fakePrisma(null);
    const failing = demo(
      1,
      jest.fn(() => Promise.reject(new Error('boom'))),
    );
    await expect(runSeeds(prisma, [failing], {}, quiet)).rejects.toThrow(
      'boom',
    );
  });
});
