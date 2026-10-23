import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { truncateRequestTables } from '../../../test/integration/db';
import { createUser, deleteTestUsers } from '../../../test/integration/users';
import { FailedJobsService } from '../../jobs/failed-jobs.service';
import type { JobsService } from '../../jobs/jobs.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { OUTBOX_BACKOFF_MS, OUTBOX_EMAIL_NOTIFY } from './outbox.constants';
import { OutboxProcessor } from './outbox.processor';
import { OutboxService } from './outbox.service';

const minutes = (n: number) => n * 60_000;

describe('outbox (integration)', () => {
  let prisma: PrismaService;
  let outbox: OutboxService;
  let processor: OutboxProcessor;
  let addEmailJob: jest.Mock;
  let addOutboxKickJob: jest.Mock;
  let queueEmail: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    addOutboxKickJob = jest.fn().mockResolvedValue({});
    outbox = new OutboxService({ addOutboxKickJob } as unknown as JobsService);
  });

  beforeEach(async () => {
    await truncateRequestTables(prisma);
    await prisma.failedJob.deleteMany({ where: { queueName: 'outbox' } });
    await prisma.notification.deleteMany({
      where: { type: 'request.received' },
    });
    addEmailJob = jest.fn().mockResolvedValue({ id: 'job-1' });
    const notifications = new NotificationsService(
      prisma,
      { addEmailJob } as unknown as JobsService,
      { set: jest.fn() } as unknown as Redis,
    );
    queueEmail = jest.spyOn(notifications, 'queueEmail');
    processor = new OutboxProcessor(
      prisma,
      notifications,
      new FailedJobsService(prisma, {} as JobsService),
    );
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { type: 'request.received' },
    });
    await deleteTestUsers(prisma);
    await prisma.$disconnect();
  });

  it('add writes inside the caller’s transaction and vanishes on rollback', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.add(tx, OUTBOX_EMAIL_NOTIFY, { a: 1 });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prisma.outboxEvent.count()).toBe(0);

    await prisma.$transaction((tx) =>
      outbox.add(tx, OUTBOX_EMAIL_NOTIFY, { a: 1 }),
    );
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('kick enqueues a job and swallows queue errors', async () => {
    await outbox.kick();
    expect(addOutboxKickJob).toHaveBeenCalledTimes(1);

    addOutboxKickJob.mockRejectedValueOnce(new Error('redis down'));
    await expect(outbox.kick()).resolves.toBeUndefined();
  });

  it('delivers email.notify through request_update and marks the row processed', async () => {
    const user = await createUser(prisma);
    await prisma.$transaction((tx) =>
      outbox.add(tx, OUTBOX_EMAIL_NOTIFY, {
        recipientId: user.id,
        event: 'request.received',
        title: 'Request received',
        message: 'We have received your request XPR-00001.',
        link: '/requests',
      }),
    );

    expect(await processor.processPending()).toBe(1);

    expect(queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: user.email,
        templateKey: 'request_update',
        payload: {
          title: 'Request received',
          message: 'We have received your request XPR-00001.',
          link: '/requests',
        },
      }),
    );
    expect(addEmailJob).toHaveBeenCalledTimes(1);
    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.processedAt).not.toBeNull();
    expect(row.attempts).toBe(1);

    expect(await processor.processPending()).toBe(0);
    expect(addEmailJob).toHaveBeenCalledTimes(1);
  });

  it('processes rows oldest first', async () => {
    const first = await createUser(prisma);
    const second = await createUser(prisma);
    const payload = (recipientId: string) => ({
      recipientId,
      event: 'request.received',
      title: 't',
      message: 'm',
    });
    await prisma.outboxEvent.create({
      data: {
        type: OUTBOX_EMAIL_NOTIFY,
        payload: payload(second.id),
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    await prisma.outboxEvent.create({
      data: {
        type: OUTBOX_EMAIL_NOTIFY,
        payload: payload(first.id),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    await processor.processPending();

    const calls = queueEmail.mock.calls as Array<[{ recipientUserId: string }]>;
    const order = calls.map(([input]) => input.recipientUserId);
    expect(order).toEqual([first.id, second.id]);
  });

  it('skips a recipient who is no longer active and still marks the row done', async () => {
    const user = await createUser(prisma, { status: 'suspended' });
    await prisma.outboxEvent.create({
      data: {
        type: OUTBOX_EMAIL_NOTIFY,
        payload: {
          recipientId: user.id,
          event: 'request.received',
          title: 't',
          message: 'm',
        },
      },
    });

    await processor.processPending();

    expect(queueEmail).not.toHaveBeenCalled();
    expect(
      (await prisma.outboxEvent.findFirstOrThrow()).processedAt,
    ).not.toBeNull();
  });

  it('retries with 1, 5, 15 and 60 minute waits, then records a FailedJob', async () => {
    const row = await prisma.outboxEvent.create({
      data: { type: 'unknown.type', payload: { x: 1 } },
    });
    let now = new Date('2026-03-01T10:00:00Z');

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await processor.processPending(now);
      const after = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.attempts).toBe(attempt);
      expect(after.processedAt).toBeNull();
      expect(after.lastError).toContain('Unknown outbox event type');
      expect(after.nextAttemptAt?.getTime()).toBe(
        now.getTime() + OUTBOX_BACKOFF_MS[attempt - 1],
      );

      await processor.processPending(
        new Date(now.getTime() + OUTBOX_BACKOFF_MS[attempt - 1] - 1000),
      );
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
          .attempts,
      ).toBe(attempt);

      now = new Date(now.getTime() + OUTBOX_BACKOFF_MS[attempt - 1]);
    }
    expect(OUTBOX_BACKOFF_MS).toEqual([
      minutes(1),
      minutes(5),
      minutes(15),
      minutes(60),
    ]);
    expect(
      await prisma.failedJob.count({ where: { queueName: 'outbox' } }),
    ).toBe(0);

    await processor.processPending(now);
    const final = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(final.attempts).toBe(5);
    expect(final.nextAttemptAt).toBeNull();

    const failed = await prisma.failedJob.findFirstOrThrow({
      where: { queueName: 'outbox' },
    });
    expect(failed).toMatchObject({ jobId: row.id, jobName: 'outbox.event' });

    const later = new Date(now.getTime() + minutes(600));
    await processor.processPending(later);
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
        .attempts,
    ).toBe(5);
  });

  it('does not run a row twice when two sweeps overlap', async () => {
    const user = await createUser(prisma);
    await prisma.outboxEvent.create({
      data: {
        type: OUTBOX_EMAIL_NOTIFY,
        payload: {
          recipientId: user.id,
          event: 'request.received',
          title: 't',
          message: 'm',
        },
      },
    });

    await Promise.all([processor.processPending(), processor.processPending()]);

    expect(addEmailJob).toHaveBeenCalledTimes(1);
  });

  it('a retried FailedJob resets the row so it runs again', async () => {
    const row = await prisma.outboxEvent.create({
      data: { type: 'unknown.type', payload: {}, attempts: 5 },
    });
    await processor.process({
      name: 'outbox.event',
      data: { outboxEventId: row.id },
    } as never);
    const after = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.attempts).toBe(1);
  });
});
