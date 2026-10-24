import { Injectable } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/types/request-user';

export type ApprovalFilter = 'can_act' | 'mine' | 'all' | 'overdue';

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService, private readonly actors: ActorService) {}

  async list(user: RequestUser, options: { filter?: ApprovalFilter; kind?: string; page?: number }) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind !== 'staff') throw new AppError(403, 'FORBIDDEN', 'Staff access is required.');
    requirePermission(actor, 'request.review');
    const now = new Date();
    const filter = options.filter ?? 'can_act';
    const where = {
      closedAt: null,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(filter === 'overdue' ? { dueAt: { lte: now } } : {}),
    };
    const take = 25;
    const page = Math.max(1, options.page ?? 1);
    const [rows, total, open, overdue] = await Promise.all([
      this.prisma.approvalDeadline.findMany({ where, orderBy: [{ dueAt: 'asc' }, { openedAt: 'asc' }], skip: (page - 1) * take, take }),
      this.prisma.approvalDeadline.count({ where }),
      this.prisma.approvalDeadline.count({ where: { closedAt: null } }),
      this.prisma.approvalDeadline.count({ where: { closedAt: null, dueAt: { lte: now } } }),
    ]);
    const quoteIds = rows.filter((row) => row.kind === 'quote_approval').map((row) => row.itemId);
    const quotes = quoteIds.length ? await this.prisma.quote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, requestId: true, lastEditedBy: true } }) : [];
    const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
    const data = rows.map((row) => {
      const quote = row.kind === 'quote_approval' ? quoteById.get(row.itemId) : undefined;
      const blockedReason = quote?.lastEditedBy === user.id ? 'You edited this quote last.' : null;
      return {
        id: row.id,
        kind: row.kind,
        itemId: row.itemId,
        requestId: row.requestId,
        openedAt: row.openedAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        overdue: row.dueAt <= now,
        canDecide: blockedReason === null,
        blockedReason,
      };
    }).filter((row) => filter !== 'can_act' || row.canDecide);
    return { data, page, pageSize: take, total: filter === 'can_act' ? data.length : total, counts: { open, overdue } };
  }

  async counts(user: RequestUser) {
    const actor = await this.actors.resolve(user.id);
    if (actor.kind !== 'staff') throw new AppError(403, 'FORBIDDEN', 'Staff access is required.');
    requirePermission(actor, 'request.review');
    const now = new Date();
    const [open, overdue] = await Promise.all([
      this.prisma.approvalDeadline.count({ where: { closedAt: null } }),
      this.prisma.approvalDeadline.count({ where: { closedAt: null, dueAt: { lte: now } } }),
    ]);
    return { open, overdue };
  }
}
