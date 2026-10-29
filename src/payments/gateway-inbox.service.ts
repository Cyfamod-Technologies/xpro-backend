import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { PrismaService } from '../prisma/prisma.service';
import {
  GATEWAY_EVENT_LEASE_MS,
  GATEWAY_EVENT_MAX_ATTEMPTS,
  GatewayEventStatus,
  decideReclaim,
  failureOutcome,
  type InboxRow,
} from './domain/webhook-reclaim';

export type InboundEvent = {
  fingerprint: string;
  event: string;
  reference: string | null;
  /** Gateway object id the event is about (for example a refund id). */
  subjectId: string | null;
};

export type EventOutcome = {
  status: 'processed' | 'ignored' | 'quarantined';
  reason?: string;
  /** The event changed nothing because an earlier one already did. */
  duplicate?: boolean;
};

export type EventProcessor = (event: InboundEvent) => Promise<EventOutcome>;

type InboxDb = Pick<Prisma.TransactionClient, 'gatewayEvent'>;

const SWEEP_BATCH = 25;
const ERROR_LIMIT = 500;

/**
 * The gateway inbox (05 §4.4, §8). A signed event is stored before any work
 * runs. A failed or abandoned event is claimed again when Paystack redelivers
 * it and by the timers sweep, with backoff, and is dead-lettered with an alert
 * after the last attempt.
 */
@Injectable()
export class GatewayInboxService {
  private readonly logger = new Logger(GatewayInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async receive(
    event: InboundEvent & { rawBodyDigest: string },
    process: EventProcessor,
    now = new Date(),
  ): Promise<{ accepted: true; duplicate: boolean }> {
    try {
      await this.prisma.gatewayEvent.create({
        data: {
          fingerprint: event.fingerprint,
          event: event.event,
          reference: event.reference,
          subjectId: event.subjectId,
          rawBodyDigest: event.rawBodyDigest,
          signatureValid: true,
          status: GatewayEventStatus.processing,
          nextAttemptAt: leaseEnd(now),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.gatewayEvent.findUnique({
        where: { fingerprint: event.fingerprint },
      });
      if (!row) throw error;
      const claimed = await this.reclaim(row, 'redelivery', now);
      if (!claimed) return { accepted: true, duplicate: true };
      return this.run(rowToEvent(row), process, true, now);
    }
    return this.run(event, process, true, now);
  }

  /** Retries due `failed` events and stale `processing` ones. Never throws for a single event. */
  async sweep(process: EventProcessor, now = new Date()): Promise<number> {
    const rows = await this.prisma.gatewayEvent.findMany({
      where: {
        OR: [
          {
            status: GatewayEventStatus.failed,
            attempts: { lt: GATEWAY_EVENT_MAX_ATTEMPTS },
            nextAttemptAt: { lte: now },
          },
          {
            status: GatewayEventStatus.processing,
            OR: [
              { nextAttemptAt: { lte: now } },
              {
                nextAttemptAt: null,
                receivedAt: {
                  lte: new Date(now.getTime() - GATEWAY_EVENT_LEASE_MS),
                },
              },
            ],
          },
        ],
      },
      orderBy: { receivedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    let retried = 0;
    for (const row of rows) {
      try {
        if (!(await this.reclaim(row, 'sweeper', now))) continue;
        retried += 1;
        await this.run(rowToEvent(row), process, false, now);
      } catch (error) {
        this.logger.error(
          `Gateway event ${row.id} retry failed: ${String(error)}`,
        );
      }
    }
    return retried;
  }

  /** Records the final state inside the caller's transaction, so it commits with the money it settled. */
  async markDone(
    db: InboxDb,
    fingerprint: string,
    outcome: EventOutcome,
    now = new Date(),
  ): Promise<void> {
    await db.gatewayEvent.updateMany({
      where: { fingerprint, status: GatewayEventStatus.processing },
      data: {
        status: outcome.status,
        lastError: outcome.reason?.slice(0, ERROR_LIMIT) ?? null,
        processedAt: now,
        nextAttemptAt: null,
      },
    });
  }

  private async run(
    event: InboundEvent,
    process: EventProcessor,
    rethrow: boolean,
    now: Date,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    let outcome: EventOutcome;
    try {
      outcome = await process(event);
    } catch (error) {
      await this.fail(event, error, now);
      if (rethrow) throw error;
      return { accepted: true, duplicate: false };
    }
    await this.markDone(this.prisma, event.fingerprint, outcome, now);
    return { accepted: true, duplicate: outcome.duplicate ?? false };
  }

  /** Takes the row for this worker with a conditional update. False when it is done, leased elsewhere, too early, or lost the race. */
  private async reclaim(
    row: InboxRow & {
      fingerprint: string;
      event: string;
      reference: string | null;
    },
    source: 'redelivery' | 'sweeper',
    now: Date,
  ): Promise<boolean> {
    const decision = decideReclaim(row, now, source);
    if (decision.action === 'dead_letter') {
      await this.deadLetter(row.fingerprint, row.status, now);
      return false;
    }
    if (decision.action !== 'reclaim') return false;
    const claimed = await this.prisma.gatewayEvent.updateMany({
      where: {
        fingerprint: row.fingerprint,
        status: row.status,
        attempts: row.attempts,
      },
      data: {
        status: GatewayEventStatus.processing,
        nextAttemptAt: leaseEnd(now),
        ...(decision.stale ? { attempts: { increment: 1 } } : {}),
      },
    });
    return claimed.count === 1;
  }

  private async fail(
    event: InboundEvent,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const row = await this.prisma.gatewayEvent.findUnique({
      where: { fingerprint: event.fingerprint },
      select: { attempts: true },
    });
    const attempts = (row?.attempts ?? 0) + 1;
    const next = failureOutcome(attempts, now);
    const message =
      error instanceof Error ? error.message : 'Event processing failed.';
    const updated = await this.prisma.gatewayEvent.updateMany({
      where: {
        fingerprint: event.fingerprint,
        status: GatewayEventStatus.processing,
      },
      data: {
        status: next.status,
        attempts: { increment: 1 },
        lastError: message.slice(0, ERROR_LIMIT),
        nextAttemptAt: next.nextAttemptAt,
      },
    });
    if (updated.count === 1 && next.status === GatewayEventStatus.deadLetter)
      await this.alertDeadLetter(event, GatewayEventStatus.processing);
  }

  private async deadLetter(
    fingerprint: string,
    from: string,
    now: Date,
  ): Promise<void> {
    const updated = await this.prisma.gatewayEvent.updateMany({
      where: {
        fingerprint,
        status: {
          in: [GatewayEventStatus.failed, GatewayEventStatus.processing],
        },
      },
      data: {
        status: GatewayEventStatus.deadLetter,
        nextAttemptAt: null,
        processedAt: now,
      },
    });
    if (updated.count !== 1) return;
    const row = await this.prisma.gatewayEvent.findUnique({
      where: { fingerprint },
    });
    if (row) await this.alertDeadLetter(rowToEvent(row), from);
  }

  private async alertDeadLetter(
    event: InboundEvent,
    from: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          entityType: 'gateway_event',
          entityId: event.fingerprint,
          action: 'Gateway event dead-lettered',
          metadata: {
            requestId: null,
            command: 'gateway.deadLetter',
            resourceType: 'gateway_event',
            resourceId: event.fingerprint,
            changes: {
              event: event.event,
              reference: event.reference,
              before: { status: from },
              after: { status: GatewayEventStatus.deadLetter },
            },
          },
        },
      });
      await this.dispatcher.dispatchAlert(tx, 'gateway.event_dead_lettered', {
        event: event.event,
        reference: event.reference ?? 'no reference',
      });
    });
  }
}

const leaseEnd = (now: Date) =>
  new Date(now.getTime() + GATEWAY_EVENT_LEASE_MS);

const rowToEvent = (row: {
  fingerprint: string;
  event: string;
  reference: string | null;
  subjectId: string | null;
}): InboundEvent => ({
  fingerprint: row.fingerprint,
  event: row.event,
  reference: row.reference,
  subjectId: row.subjectId,
});

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';
