import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginationArgs } from '../common/utils/paginate';
import { PrismaService } from '../prisma/prisma.service';

type InboxDb = Pick<Prisma.TransactionClient, 'inAppNotification'>;

export type InboxRowInput = {
  recipientId: string;
  event: string;
  title: string;
  message: string;
  requestId?: string | null;
  link?: string | null;
  mandatory?: boolean;
};

export type InboxItemDto = {
  id: string;
  event: string;
  title: string;
  message: string;
  requestId: string | null;
  link: string | null;
  mandatory: boolean;
  readAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Inside the command transaction. A recipient gets one row per event per call. */
  async createMany(tx: InboxDb, rows: InboxRowInput[]): Promise<number> {
    const seen = new Set<string>();
    const data = rows
      .filter((row) => {
        const key = `${row.recipientId}\n${row.event}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((row) => ({
        recipientId: row.recipientId,
        event: row.event,
        title: row.title,
        message: row.message,
        requestId: row.requestId ?? null,
        link: row.link ?? null,
        mandatory: row.mandatory ?? false,
      }));
    if (data.length === 0) return 0;
    const result = await tx.inAppNotification.createMany({ data });
    return result.count;
  }

  async list(
    userId: string,
    query: { unread?: boolean; page: number; itemsPerPage: number },
  ) {
    const where: Prisma.InAppNotificationWhereInput = {
      recipientId: userId,
      ...(query.unread ? { readAt: null } : {}),
    };
    const { skip, take } = paginationArgs(query.page, query.itemsPerPage);
    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.inAppNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.inAppNotification.count({ where }),
      this.prisma.inAppNotification.count({
        where: { recipientId: userId, readAt: null },
      }),
    ]);
    return {
      items: await Promise.all(rows.map((row) => this.toDto(row))),
      meta: { unread, total, page: query.page },
    };
  }

  async markRead(userId: string, notificationId?: string) {
    const result = await this.prisma.inAppNotification.updateMany({
      where: {
        recipientId: userId,
        readAt: null,
        ...(notificationId ? { id: notificationId } : {}),
      },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  private async toDto(row: Prisma.InAppNotificationGetPayload<object>): Promise<InboxItemDto> {
    const request = row.requestId
      ? await this.prisma.serviceRequest.findUnique({
          where: { id: row.requestId },
          select: { number: true },
        })
      : null;
    return {
      id: row.id,
      event: row.event,
      title: row.title,
      message: row.message,
      requestId: request ? `XPR-${String(request.number).padStart(5, '0')}` : null,
      link: row.link,
      mandatory: row.mandatory,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}
