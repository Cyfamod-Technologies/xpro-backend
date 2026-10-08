import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { paginationArgs, toPaginatedResult } from '../common/utils/paginate';

type AuditInput = {
  actorType: string;
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  metadata?: unknown;
  ipAddress?: string | null;
};

export class ListAuditLogsQueryDto {
  page = 1;
  limit = 25;
  entityType?: string;
  action?: string;
}

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCtx: RequestContextService,
    @InjectQueue('audit-logs') private readonly auditQueue: Queue,
  ) {}

  record(input: AuditInput): void {
    const ipAddress = input.ipAddress ?? this.requestCtx.getIp() ?? null;

    void this.auditQueue.add('write', {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      action: input.action,
      metadata: input.metadata,
      ipAddress,
      timestamp: new Date().toISOString(),
    });
  }

  async list(query: ListAuditLogsQueryDto) {
    const { page, limit, entityType, action } = query;
    const where = {
      ...(entityType ? { entityType } : {}),
      ...(action ? { action } : {}),
    };
    const { skip, take } = paginationArgs(page, limit);

    const [logs, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return toPaginatedResult(logs, total, page, limit);
  }
}
