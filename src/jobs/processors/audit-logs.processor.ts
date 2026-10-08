import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { FailedJobsService } from '../failed-jobs.service';

interface AuditLogJobData {
  actorType: string;
  actorId: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  metadata?: unknown;
  ipAddress: string | null;
  timestamp: string;
}

function buildPublicId(date: Date): string {
  const fmt = new Intl.DateTimeFormat(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const p = Object.fromEntries(
    fmt.formatToParts(date).map(({ type, value }) => [type, value]),
  );

  return `AUD-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

@Processor('audit-logs')
export class AuditLogsProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  async process(job: Job<AuditLogJobData>): Promise<void> {
    const {
      actorType,
      actorId,
      entityType,
      entityId,
      action,
      metadata,
      ipAddress,
      timestamp,
    } = job.data;

    let actorContext: { email: string; role: string | null } | undefined;
    if (actorType === 'user' && actorId) {
      const user = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { email: true, role: true },
      });
      if (user) actorContext = { email: user.email, role: user.role };
    }

    const baseMetadata: Record<string, unknown> =
      metadata === undefined
        ? {}
        : (JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>);

    const enrichedMetadata: Prisma.InputJsonValue | undefined = (
      actorContext
        ? { ...baseMetadata, actor: actorContext }
        : Object.keys(baseMetadata).length
          ? baseMetadata
          : undefined
    ) as Prisma.InputJsonValue | undefined;

    const createdAt = new Date(timestamp);
    const publicId = buildPublicId(createdAt);

    try {
      await this.prisma.auditLog.create({
        data: {
          publicId,
          actorType,
          actorId: actorId ?? null,
          entityType,
          entityId: entityId ?? null,
          action,
          metadata: enrichedMetadata,
          ipAddress,
          createdAt,
        },
      });
      this.logger.log(
        `publicId=${publicId} action=${action} entityType=${entityType} entityId=${entityId ?? 'none'}`,
      );
    } catch (error) {
      await this.failedJobs.record('audit-logs', job, error);
      this.logger.error(
        `Failed publicId=${publicId} action=${action} error=${String(error)}`,
      );
      throw error;
    }
  }
}
