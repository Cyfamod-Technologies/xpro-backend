import { Injectable } from '@nestjs/common';
import type { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import type { ActorContext } from '../platform/actor/actor.types';
import { SettingsService } from '../platform/settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL, formatRequestId, REQUEST_STATUSES } from './domain/statuses';
import type { RequestStatus } from './domain/statuses';
import {
  CONVERSATION_DEFAULT_LIMIT,
  type ConversationListQueryDto,
} from './dto/conversation-list-query.dto';
import {
  conversationRowsSql,
  conversationStatusCountsSql,
  decodeCursor,
  encodeCursor,
  previewText,
  readableChannels,
  type ConversationRow,
  type ConversationStatusCountRow,
} from './conversations.query';
import { forbiddenChannel, renderAuthor } from './messages.service';
import { listProjection } from './projections/list.projection';
import { LIST_ROW_SELECT, RequestListLoader } from './request-list.loader';

type PersonRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
};

export type ConversationItem = {
  requestId: string;
  title: string;
  status: RequestStatus;
  statusLabel: string;
  closed: boolean;
  owner: { id: string; name: string } | null;
  customer: { name: string };
  provider: { name: string } | null;
  lastMessage: {
    audience: 'customer' | 'provider' | 'internal';
    authorRole: string;
    authorLabel: string;
    text: string;
    at: Date;
  };
  waitingForXpro: number;
};

export type ConversationList = {
  data: ConversationItem[];
  meta: {
    nextCursor: string | null;
    statusCounts: Partial<Record<RequestStatus, number>>;
  };
};

function personName(person: Omit<PersonRow, 'id'>): string {
  return (
    [person.firstName, person.lastName].filter(Boolean).join(' ').trim() ||
    person.name ||
    person.email
  );
}

/**
 * The staff Messages inbox (04 §11.6): one row per request that has a message
 * the viewer may read. Message text goes to the caller only; it is never
 * logged, audited or put in a notification here.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly listLoader: RequestListLoader,
    private readonly settings: SettingsService,
  ) {}

  async list(
    user: RequestUser,
    query: ConversationListQueryDto,
  ): Promise<ConversationList> {
    const actor = await this.actors.resolve(user.id);
    const channels = readableChannels(actor);
    if (!channels.length) throw forbiddenChannel();

    const limit = query.limit ?? CONVERSATION_DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const q = query.q?.trim() || undefined;
    const base = { channels, q };

    const [found, countRows] = await Promise.all([
      this.prisma.$queryRaw<ConversationRow[]>(
        conversationRowsSql({
          ...base,
          statuses: query.status,
          cursor,
          take: limit + 1,
        }),
      ),
      this.prisma.$queryRaw<ConversationStatusCountRow[]>(
        conversationStatusCountsSql(base),
      ),
    ]);

    const rows = found.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor =
      found.length > limit && last
        ? encodeCursor({ at: last.lastMessageAt, number: last.number })
        : null;
    const statusCounts: ConversationList['meta']['statusCounts'] = {};
    for (const status of REQUEST_STATUSES) {
      const row = countRows.find((item) => item.status === status);
      if (row && row.count > 0) statusCounts[status] = row.count;
    }
    if (!rows.length) return { data: [], meta: { nextCursor, statusCounts } };

    const [people, providers, labels] = await Promise.all([
      this.people(rows),
      this.providerNames(rows),
      this.statusLabels(rows, actor),
    ]);
    const data = rows.map((row): ConversationItem => {
      const status = row.status as RequestStatus;
      const owner = row.staffOwnerId ? people.get(row.staffOwnerId) : undefined;
      return {
        requestId: formatRequestId(row.number),
        title: row.title,
        status,
        statusLabel: labels.get(row.id) ?? status,
        closed: TERMINAL.has(status),
        owner:
          row.staffOwnerId && owner
            ? { id: row.staffOwnerId, name: personName(owner) }
            : null,
        customer: { name: row.customerName },
        provider: row.providerId
          ? { name: providers.get(row.providerId) ?? 'Provider' }
          : null,
        lastMessage: {
          audience: row.channel,
          authorRole: row.authorRole,
          authorLabel: authorLabel(row, people),
          text: previewText(row.text),
          at: row.lastMessageAt,
        },
        waitingForXpro: row.waiting,
      };
    });
    return { data, meta: { nextCursor, statusCounts } };
  }

  /** Staff owners and message authors, in one query. */
  private async people(rows: ConversationRow[]) {
    const ids = [
      ...new Set(
        rows
          .flatMap((row) => [row.staffOwnerId, row.authorId])
          .filter(isString),
      ),
    ];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            name: true,
            email: true,
          },
        })
      : [];
    return new Map<string, PersonRow>(users.map((user) => [user.id, user]));
  }

  /** The current provider's business name, falling back to the account holder's name. */
  private async providerNames(rows: ConversationRow[]) {
    const ids = [
      ...new Set(rows.map((row) => row.providerId).filter(isString)),
    ];
    const profiles = ids.length
      ? await this.prisma.providerProfile.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            businessName: true,
            user: { select: { firstName: true, lastName: true } },
          },
        })
      : [];
    return new Map(
      profiles.map((profile) => [
        profile.id,
        profile.businessName?.trim() ||
          [profile.user.firstName, profile.user.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() ||
          'Provider',
      ]),
    );
  }

  /** The request list's staff `statusLabel`, from the same snapshots and projection. */
  private async statusLabels(rows: ConversationRow[], actor: ActorContext) {
    const requests = await this.prisma.serviceRequest.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      select: LIST_ROW_SELECT,
    });
    const [loaded, snapshot] = await Promise.all([
      this.listLoader.attachSnapshots(this.prisma, requests),
      this.settings.snapshot(),
    ]);
    const settings = Object.fromEntries(
      snapshot.map(({ key, value }) => [key, value]),
    );
    const now = new Date();
    const labels = new Map<string, string>();
    for (const { row, snapshot: requestSnapshot } of loaded) {
      // The list's own projection, so staff see identical labels in both.
      const projected = listProjection(
        row,
        requestSnapshot,
        actor,
        now,
        settings,
      );
      if (typeof projected.statusLabel === 'string')
        labels.set(row.id, projected.statusLabel);
    }
    return labels;
  }
}

function authorLabel(row: ConversationRow, people: Map<string, PersonRow>) {
  if (row.authorRole === 'system') return 'XPro system';
  const names = new Map<string, string>();
  const person = row.authorId ? people.get(row.authorId) : undefined;
  if (row.authorId && person) names.set(row.authorId, personName(person));
  return renderAuthor(row.authorRole, row.authorId, { kind: 'staff' }, names);
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}
