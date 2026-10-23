import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobsService } from '../../jobs/jobs.service';

type OutboxDb = Pick<Prisma.TransactionClient, 'outboxEvent'>;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly jobs: JobsService) {}

  /** Write inside the command transaction; call `kick()` after it commits. */
  add(tx: OutboxDb, type: string, payload: Prisma.InputJsonValue) {
    return tx.outboxEvent.create({ data: { type, payload } });
  }

  /** Best effort: the 30 s sweep picks up anything a failed kick misses. */
  async kick(): Promise<void> {
    try {
      await this.jobs.addOutboxKickJob();
    } catch (error) {
      this.logger.warn(
        `Outbox kick failed, sweep will catch up: ${String(error)}`,
      );
    }
  }
}
