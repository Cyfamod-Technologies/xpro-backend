import { Prisma } from '@prisma/client';
import {
  GATEWAY_EVENT_BACKOFF_MS,
  GATEWAY_EVENT_MAX_ATTEMPTS,
} from './domain/webhook-reclaim';
import {
  GatewayInboxService,
  type EventProcessor,
  type InboundEvent,
} from './gateway-inbox.service';

type Row = {
  id: string;
  fingerprint: string;
  event: string;
  reference: string | null;
  subjectId: string | null;
  rawBodyDigest: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  receivedAt: Date;
  processedAt: Date | null;
};

const NOW = new Date('2026-10-25T10:00:00.000Z');
const event = (
  fingerprint = 'fp-1',
): InboundEvent & { rawBodyDigest: string } => ({
  fingerprint,
  rawBodyDigest: fingerprint,
  event: 'charge.success',
  reference: 'xpro_1',
  subjectId: null,
});

/** A small in-memory stand-in for the `gateway_events` table. */
function build() {
  const rows = new Map<string, Row>();
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      const actual = row[key as keyof Row];
      if (expected && typeof expected === 'object' && 'in' in expected)
        return (expected as { in: unknown[] }).in.includes(actual);
      return actual === expected;
    });
  const apply = (row: Row, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value)
        (row as unknown as Record<string, unknown>)[key] =
          (row[key as keyof Row] as number) +
          (value as { increment: number }).increment;
      else (row as unknown as Record<string, unknown>)[key] = value;
    }
  };
  const gatewayEvent = {
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      if (rows.has(data.fingerprint!))
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        });
      const row: Row = {
        id: `id-${rows.size + 1}`,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        processedAt: null,
        receivedAt: NOW,
        subjectId: null,
        ...data,
      } as Row;
      rows.set(row.fingerprint, row);
      return Promise.resolve(row);
    }),
    findUnique: jest.fn(({ where }: { where: { fingerprint: string } }) =>
      Promise.resolve(rows.get(where.fingerprint) ?? null),
    ),
    findMany: jest.fn(() => Promise.resolve([...rows.values()])),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of rows.values())
          if (matches(row, where)) {
            apply(row, data);
            count += 1;
          }
        return Promise.resolve({ count });
      },
    ),
  };
  const tx = { gatewayEvent, auditLog: { create: jest.fn() } };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const dispatcher = { dispatchAlert: jest.fn().mockResolvedValue(undefined) };
  const service = new GatewayInboxService(prisma as never, dispatcher as never);
  /** Puts a row in the table directly, in the state a test needs. */
  const seed = (overrides: Partial<Row> = {}) => {
    const row: Row = {
      id: 'id-seed',
      fingerprint: 'fp-1',
      event: 'charge.success',
      reference: 'xpro_1',
      subjectId: null,
      rawBodyDigest: 'fp-1',
      status: 'processing',
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      receivedAt: NOW,
      processedAt: null,
      ...overrides,
    };
    rows.set(row.fingerprint, row);
    return row;
  };
  return { service, rows, dispatcher, tx, seed };
}

const ok: EventProcessor = () => Promise.resolve({ status: 'processed' });

describe('GatewayInboxService.receive', () => {
  it('stores the event as processing, runs it once and marks it processed', async () => {
    const { service, rows } = build();
    const process = jest.fn(ok);

    const result = await service.receive(event(), process, NOW);

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(process).toHaveBeenCalledTimes(1);
    expect(rows.get('fp-1')).toMatchObject({
      status: 'processed',
      processedAt: NOW,
      nextAttemptAt: null,
    });
  });

  it('acknowledges a duplicate of a processed event without running it again', async () => {
    const { service } = build();
    await service.receive(event(), ok, NOW);
    const process = jest.fn(ok);

    const result = await service.receive(event(), process, NOW);

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(process).not.toHaveBeenCalled();
  });

  it('reports a processor that changed nothing as a duplicate', async () => {
    const { service } = build();

    const result = await service.receive(
      event(),
      () => Promise.resolve({ status: 'processed', duplicate: true }),
      NOW,
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
  });

  it('does not run an event another worker is still processing', async () => {
    const { service, seed } = build();
    seed({ nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    const process = jest.fn(ok);

    const result = await service.receive(event(), process, NOW);

    expect(result.duplicate).toBe(true);
    expect(process).not.toHaveBeenCalled();
  });

  it('fails the event and lets the 500 reach Paystack, then reprocesses the redelivery (failed-then-retried)', async () => {
    const { service, rows } = build();
    const failing = jest.fn().mockRejectedValue(new Error('verify timed out'));

    await expect(service.receive(event(), failing, NOW)).rejects.toThrow(
      'verify timed out',
    );
    expect(rows.get('fp-1')).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'verify timed out',
      nextAttemptAt: new Date(NOW.getTime() + GATEWAY_EVENT_BACKOFF_MS[0]),
    });

    const process = jest.fn(ok);
    const retry = await service.receive(event(), process, NOW);

    expect(retry).toEqual({ accepted: true, duplicate: false });
    expect(process).toHaveBeenCalledTimes(1);
    expect(rows.get('fp-1')).toMatchObject({
      status: 'processed',
      attempts: 1,
    });
  });

  it('reprocesses a stale processing row left by a crashed worker', async () => {
    const { service, rows, seed } = build();
    seed({ nextAttemptAt: new Date(NOW.getTime() - 1) });
    const process = jest.fn(ok);

    await service.receive(event(), process, NOW);

    expect(process).toHaveBeenCalledTimes(1);
    expect(rows.get('fp-1')).toMatchObject({
      status: 'processed',
      attempts: 1,
    });
  });

  it('dead-letters on the last failure and alerts Finance and super admins', async () => {
    const { service, rows, dispatcher, tx, seed } = build();
    seed({ status: 'failed', attempts: GATEWAY_EVENT_MAX_ATTEMPTS - 1 });

    await expect(
      service.receive(
        event(),
        () => Promise.reject(new Error('still failing')),
        NOW,
      ),
    ).rejects.toThrow('still failing');

    expect(rows.get('fp-1')).toMatchObject({
      status: 'dead_letter',
      attempts: GATEWAY_EVENT_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
    expect(dispatcher.dispatchAlert).toHaveBeenCalledWith(
      tx,
      'gateway.event_dead_lettered',
      { event: 'charge.success', reference: 'xpro_1' },
    );
  });

  it('keeps a quarantined event quarantined when it is redelivered', async () => {
    const { service } = build();
    await service.receive(
      event(),
      () => Promise.resolve({ status: 'quarantined', reason: 'amount' }),
      NOW,
    );
    const process = jest.fn(ok);

    const result = await service.receive(event(), process, NOW);

    expect(result.duplicate).toBe(true);
    expect(process).not.toHaveBeenCalled();
  });
});

describe('GatewayInboxService.sweep', () => {
  it('retries a failed event only after its backoff', async () => {
    const { service, rows } = build();
    await expect(
      service.receive(event(), () => Promise.reject(new Error('boom')), NOW),
    ).rejects.toThrow('boom');
    const process = jest.fn(ok);

    expect(await service.sweep(process, NOW)).toBe(0);
    expect(process).not.toHaveBeenCalled();

    const later = new Date(NOW.getTime() + GATEWAY_EVENT_BACKOFF_MS[0]);
    expect(await service.sweep(process, later)).toBe(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(rows.get('fp-1')!.status).toBe('processed');
  });

  it('records a sweeper failure with a longer backoff and never throws', async () => {
    const { service, rows } = build();
    await expect(
      service.receive(event(), () => Promise.reject(new Error('boom')), NOW),
    ).rejects.toThrow('boom');
    const later = new Date(NOW.getTime() + GATEWAY_EVENT_BACKOFF_MS[0]);

    await expect(
      service.sweep(() => Promise.reject(new Error('boom again')), later),
    ).resolves.toBe(1);

    expect(rows.get('fp-1')).toMatchObject({
      status: 'failed',
      attempts: 2,
      nextAttemptAt: new Date(later.getTime() + GATEWAY_EVENT_BACKOFF_MS[1]),
    });
  });

  it('dead-letters a failed event that used up its attempts and does not run it', async () => {
    const { service, rows, dispatcher, seed } = build();
    seed({
      status: 'failed',
      attempts: GATEWAY_EVENT_MAX_ATTEMPTS,
      nextAttemptAt: new Date(NOW.getTime() - 1),
    });
    const process = jest.fn(ok);

    await service.sweep(process, NOW);

    expect(process).not.toHaveBeenCalled();
    expect(rows.get('fp-1')!.status).toBe('dead_letter');
    expect(dispatcher.dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it('claims a row once when two sweeps race for it', async () => {
    const { service, seed } = build();
    seed({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() - 1),
    });
    const process = jest.fn(ok);

    await Promise.all([
      service.sweep(process, NOW),
      service.sweep(process, NOW),
    ]);

    expect(process).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayInboxService.markDone', () => {
  it('only closes a processing row, so a settled event cannot be overwritten', async () => {
    const { service, rows, tx } = build();
    await service.receive(event(), ok, NOW);

    await service.markDone(tx as never, 'fp-1', {
      status: 'quarantined',
      reason: 'late',
    });

    expect(rows.get('fp-1')!.status).toBe('processed');
  });
});
