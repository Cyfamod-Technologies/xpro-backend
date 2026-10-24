import { Test } from '@nestjs/testing';
import { truncateRequestTables } from '../../../test/integration/db';
import { FailedJobsService } from '../../jobs/failed-jobs.service';
import type { JobsService } from '../../jobs/jobs.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { TimerRegistry } from './timer-registry';
import {
  TIMER_BACKOFF_MS,
  TIMER_CLAIM_LEASE_MS,
  TIMERS_QUEUE,
} from './timers.constants';
import { TimersProcessor } from './timers.processor';
import { TimersService } from './timers.service';

const REQUEST = 'req-1';
const T0 = new Date('2026-03-01T10:00:00Z');
const minutes = (n: number) => n * 60_000;

describe('request timers (integration)', () => {
  let prisma: PrismaService;
  let timers: TimersService;
  let processor: TimersProcessor;
  let registry: TimerRegistry;
  let addTimersKickJob: jest.Mock;

  const start = (input: Partial<Parameters<TimersService['start']>[1]> = {}) =>
    prisma.$transaction((tx) =>
      timers.start(tx, {
        requestId: REQUEST,
        kind: 'T1.expire',
        dueAt: T0,
        ...input,
      }),
    );
  const rows = () =>
    prisma.requestTimer.findMany({ orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    addTimersKickJob = jest.fn().mockResolvedValue({});
    timers = new TimersService(prisma, {
      addTimersKickJob,
    } as unknown as JobsService);
  });

  beforeEach(async () => {
    await truncateRequestTables(prisma);
    await prisma.failedJob.deleteMany({ where: { queueName: TIMERS_QUEUE } });
    registry = new TimerRegistry();
    processor = new TimersProcessor(
      prisma,
      registry,
      new FailedJobsService(prisma, {} as JobsService),
    );
  });

  afterAll(async () => {
    await truncateRequestTables(prisma);
    await prisma.$disconnect();
  });

  describe('start and stop', () => {
    it('start writes inside the caller’s transaction and vanishes on rollback', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await timers.start(tx, {
            requestId: REQUEST,
            kind: 'T1.expire',
            dueAt: T0,
          });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await prisma.requestTimer.count()).toBe(0);

      const result = await start({ payload: { assignmentId: 'a-1' } });
      expect(result.created).toBe(true);
      const [row] = await rows();
      expect(row).toMatchObject({
        id: result.id,
        requestId: REQUEST,
        kind: 'T1.expire',
        refId: '',
        status: 'pending',
        attempts: 0,
        payload: { assignmentId: 'a-1' },
      });
      expect(row.dueAt.toISOString()).toBe(T0.toISOString());
    });

    it('a second start of the same pending (request, kind, ref) reschedules it instead of throwing', async () => {
      const first = await start({ refId: 'a-1', payload: { n: 1 } });
      const later = new Date(T0.getTime() + minutes(90));
      const second = await start({
        refId: 'a-1',
        dueAt: later,
        payload: { n: 2 },
      });

      expect(second).toEqual({ id: first.id, created: false });
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].dueAt.toISOString()).toBe(later.toISOString());
      expect(all[0].payload).toEqual({ n: 2 });
    });

    it('a restart resets retry state', async () => {
      await start();
      await prisma.requestTimer.updateMany({
        data: { attempts: 3, lastError: 'boom', nextAttemptAt: T0 },
      });
      await start({ dueAt: new Date(T0.getTime() + minutes(5)) });
      expect(await rows()).toEqual([
        expect.objectContaining({
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
        }),
      ]);
    });

    it('keeps separate timers per kind, per reference and per request', async () => {
      await start();
      await start({ refId: 'a-2' });
      await start({ kind: 'T1.reminder' });
      await start({ requestId: 'req-2' });
      expect(await prisma.requestTimer.count()).toBe(4);
    });

    it('allows a new pending timer once the previous one is done or cancelled', async () => {
      const first = await start();
      await prisma.requestTimer.update({
        where: { id: first.id },
        data: { status: 'done' },
      });
      const second = await start();
      expect(second.created).toBe(true);
      await timers.stop(prisma, { requestId: REQUEST, kinds: ['T1.expire'] });
      expect((await start()).created).toBe(true);
      expect(await prisma.requestTimer.count()).toBe(3);
    });

    it('the database refuses two pending rows for one key', async () => {
      await start();
      await expect(
        prisma.requestTimer.create({
          data: { requestId: REQUEST, kind: 'T1.expire', dueAt: T0 },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('stop cancels pending timers by exact kinds, by prefix and by reference', async () => {
      await start({ kind: 'T6.reminder48h' });
      await start({ kind: 'T6.autoCancel' });
      await start({ kind: 'T8.expire' });
      await start({ kind: 'T9.lapse', refId: 'q-1' });
      await start({ kind: 'T9.lapse', refId: 'q-2' });
      await start({ requestId: 'req-2', kind: 'T6.autoCancel' });

      expect(
        await prisma.$transaction((tx) =>
          timers.stop(tx, { requestId: REQUEST, kinds: { prefix: 'T6.' } }),
        ),
      ).toBe(2);
      expect(
        await timers.stop(prisma, {
          requestId: REQUEST,
          kinds: ['T9.lapse'],
          refId: 'q-1',
        }),
      ).toBe(1);
      expect(
        await timers.stop(prisma, {
          requestId: REQUEST,
          kinds: ['T6.autoCancel'],
        }),
      ).toBe(0);

      const byStatus = (status: string) =>
        prisma.requestTimer.count({ where: { status: status as 'pending' } });
      expect(await byStatus('cancelled')).toBe(3);
      expect(await byStatus('pending')).toBe(3);
    });

    it('stop leaves running and finished timers alone', async () => {
      await start();
      await prisma.requestTimer.updateMany({ data: { status: 'running' } });
      expect(
        await timers.stop(prisma, { requestId: REQUEST, kinds: ['T1.expire'] }),
      ).toBe(0);
    });

    it('kick enqueues a job and swallows queue errors', async () => {
      await timers.kick();
      expect(addTimersKickJob).toHaveBeenCalledTimes(1);
      addTimersKickJob.mockRejectedValueOnce(new Error('redis down'));
      await expect(timers.kick()).resolves.toBeUndefined();
    });

    it('makeDue pulls a pending timer forward and clears its retry wait', async () => {
      const future = new Date(T0.getTime() + minutes(600));
      await start({ dueAt: future });
      expect(await timers.makeDue(REQUEST, 'T1.expire', T0)).toBe(1);
      expect(await timers.makeDue(REQUEST, 'T1.reminder', T0)).toBe(0);
      expect((await rows())[0].dueAt.toISOString()).toBe(T0.toISOString());
    });
  });

  describe('sweeper', () => {
    it('fires a due timer once and marks it done; later timers wait', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registry.register('T1.expire', handler);
      registry.register('T1.reminder', handler);
      await start({ payload: { x: 1 } });
      await start({
        kind: 'T1.reminder',
        dueAt: new Date(T0.getTime() + minutes(10)),
      });

      expect(await processor.processDue(T0)).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: REQUEST,
          kind: 'T1.expire',
          payload: { x: 1 },
        }),
      );
      const [done, waiting] = await rows();
      expect(done).toMatchObject({ status: 'done', attempts: 1 });
      expect(done.firedAt?.toISOString()).toBe(T0.toISOString());
      expect(waiting.status).toBe('pending');

      expect(await processor.processDue(T0)).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        await processor.processDue(new Date(T0.getTime() + minutes(10))),
      ).toBe(1);
    });

    it('a due timer fires once even when two sweeps run in parallel', async () => {
      const handler = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      registry.register('T1.expire', handler);
      await start();
      await start({ refId: 'a-2' });

      const counts = await Promise.all([
        processor.processDue(T0),
        processor.processDue(T0),
        processor.processDue(T0),
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
      expect(
        await prisma.requestTimer.count({ where: { status: 'done' } }),
      ).toBe(2);
    });

    it('runs handlers oldest due first', async () => {
      const order: string[] = [];
      registry.register('T1.expire', (row) => {
        order.push(row.refId);
        return Promise.resolve();
      });
      await start({ refId: 'late', dueAt: new Date(T0.getTime() - 1000) });
      await start({ refId: 'early', dueAt: new Date(T0.getTime() - 5000) });
      await processor.processDue(T0);
      expect(order).toEqual(['early', 'late']);
    });

    it('does not run a cancelled timer', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registry.register('T1.expire', handler);
      await start();
      await timers.stop(prisma, { requestId: REQUEST, kinds: ['T1.expire'] });
      await processor.processDue(T0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('retries with 1, 5, 15 and 60 minute waits, then fails and records a FailedJob', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler broke'));
      registry.register('T1.expire', handler);
      const { id } = await start();
      let now = T0;

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await processor.processDue(now);
        const after = await prisma.requestTimer.findUniqueOrThrow({
          where: { id },
        });
        expect(after).toMatchObject({
          status: 'pending',
          attempts: attempt,
          lastError: 'handler broke',
        });
        expect(after.nextAttemptAt?.getTime()).toBe(
          now.getTime() + TIMER_BACKOFF_MS[attempt - 1],
        );

        await processor.processDue(
          new Date(now.getTime() + TIMER_BACKOFF_MS[attempt - 1] - 1000),
        );
        expect(handler).toHaveBeenCalledTimes(attempt);

        now = new Date(now.getTime() + TIMER_BACKOFF_MS[attempt - 1]);
      }
      expect(TIMER_BACKOFF_MS).toEqual([
        minutes(1),
        minutes(5),
        minutes(15),
        minutes(60),
      ]);
      expect(
        await prisma.failedJob.count({ where: { queueName: TIMERS_QUEUE } }),
      ).toBe(0);

      await processor.processDue(now);
      const final = await prisma.requestTimer.findUniqueOrThrow({
        where: { id },
      });
      expect(final).toMatchObject({
        status: 'failed',
        attempts: 5,
        lastError: 'handler broke',
        nextAttemptAt: null,
      });
      const failed = await prisma.failedJob.findFirstOrThrow({
        where: { queueName: TIMERS_QUEUE },
      });
      expect(failed).toMatchObject({
        jobId: id,
        jobName: 'request.timer',
        errorMessage: 'handler broke',
      });

      await processor.processDue(new Date(now.getTime() + minutes(600)));
      expect(handler).toHaveBeenCalledTimes(5);
    });

    it('a handler that fails once and then succeeds ends done', async () => {
      const handler = jest
        .fn()
        .mockRejectedValueOnce(new Error('once'))
        .mockResolvedValue(undefined);
      registry.register('T1.expire', handler);
      const { id } = await start();
      await processor.processDue(T0);
      await processor.processDue(new Date(T0.getTime() + minutes(1)));
      expect(
        await prisma.requestTimer.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'done', attempts: 2, lastError: null });
    });

    it('fails an unknown kind at once with a message, without retrying', async () => {
      const { id } = await start({ kind: 'T99.nope' });
      expect(await processor.processDue(T0)).toBe(0);

      const row = await prisma.requestTimer.findUniqueOrThrow({
        where: { id },
      });
      expect(row).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'Unknown timer kind: T99.nope',
        nextAttemptAt: null,
      });
      expect(
        await prisma.failedJob.count({
          where: { queueName: TIMERS_QUEUE, jobId: id },
        }),
      ).toBe(1);

      await processor.processDue(new Date(T0.getTime() + minutes(600)));
      expect(
        (await prisma.requestTimer.findUniqueOrThrow({ where: { id } }))
          .attempts,
      ).toBe(1);
    });

    it('re-runs a claimed row whose worker died once the lease expires', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registry.register('T1.expire', handler);
      const { id } = await start();
      await prisma.requestTimer.update({
        where: { id },
        data: {
          status: 'running',
          attempts: 1,
          nextAttemptAt: new Date(T0.getTime() + TIMER_CLAIM_LEASE_MS),
        },
      });

      await processor.processDue(T0);
      expect(handler).not.toHaveBeenCalled();

      await processor.processDue(new Date(T0.getTime() + TIMER_CLAIM_LEASE_MS));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        await prisma.requestTimer.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'done', attempts: 2 });
    });

    it('fails a row that died on its last attempt', async () => {
      const { id } = await start();
      await prisma.requestTimer.update({
        where: { id },
        data: { status: 'running', attempts: 5, nextAttemptAt: T0 },
      });
      await processor.processDue(T0);
      expect(
        await prisma.requestTimer.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: 'failed',
        lastError: 'Timer handler did not finish.',
      });
      expect(await prisma.failedJob.count({ where: { jobId: id } })).toBe(1);
    });

    it('cancels a retrying timer that a newer pending timer has replaced', async () => {
      registry.register('T1.expire', async () => {
        await prisma.requestTimer.create({
          data: { requestId: REQUEST, kind: 'T1.expire', dueAt: T0 },
        });
        throw new Error('broke');
      });
      const { id } = await start();
      await processor.processDue(T0);
      expect(
        await prisma.requestTimer.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'cancelled' });
    });

    it('a retried FailedJob revives the timer from attempt 1', async () => {
      const { id } = await start({ kind: 'T99.nope' });
      await processor.processDue(T0);
      registry.register('T99.nope', jest.fn().mockResolvedValue(undefined));

      await processor.process({
        name: 'request.timer',
        data: { timerId: id },
      } as never);

      expect(
        await prisma.requestTimer.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'done', attempts: 1, lastError: null });
    });
  });
});
