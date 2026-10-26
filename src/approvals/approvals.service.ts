import { Injectable } from '@nestjs/common';
import type { ApprovalDeadline, Prisma } from '@prisma/client';
import { ActorService } from '../platform/actor/actor.service';
import { requireActiveStaff } from '../platform/actor/actor.guards';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { StaffRoutingService } from '../notifications/staff-routing.service';
import {
  bankVersionOf,
  currentApprovals,
} from '../payments/domain/payout-rules';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/types/request-user';
import { APPROVAL_KINDS, approvalKindSpec } from '../requests/approvals.hooks';
import type { StaffPermission } from '../staff/staff-permissions';
import {
  evaluateCanDecide,
  type Caller,
  type DecisionFacts,
} from './can-decide';

export const APPROVAL_FILTERS = ['can_act', 'mine', 'all', 'overdue'] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];

export const APPROVAL_PAGE_SIZE = 25;
const BATCH_SIZE = 200;

export type ApprovalState = 'on_time' | 'due_soon' | 'overdue';

/** 02 §4.6, plus `id` (the deadline row), `label`, `requestCode` and `providerId` for the UI. */
export type ApprovalItem = {
  id: string;
  kind: string;
  label: string;
  itemId: string;
  requestId: string | null;
  requestCode: string | null;
  providerId: string | null;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  decidingPermission: StaffPermission;
  canDecide: boolean;
  blockedReason: string | null;
  createdAt: string;
  dueAt: string;
  remindAt: string;
  state: ApprovalState;
  version: number | null;
};

type RequestInfo = {
  id: string;
  number: number;
  title: string;
  ownerId: string;
  staffOwnerId: string | null;
  version: number;
};

export function approvalState(
  row: Pick<ApprovalDeadline, 'dueAt' | 'remindAt'>,
  now: Date,
): ApprovalState {
  if (row.dueAt <= now) return 'overdue';
  if (row.remindAt && row.remindAt <= now) return 'due_soon';
  return 'on_time';
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly routing: StaffRoutingService,
  ) {}

  async list(
    user: RequestUser,
    options: { filter?: string; kind?: string; page?: number },
  ) {
    const actor = await this.staff(user);
    const filter = parseFilter(options.filter);
    if (options.kind !== undefined && !(options.kind in APPROVAL_KINDS))
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        // new message: not in spec
        'Choose a valid approval kind.',
      );
    const now = new Date();
    const caller = callerOf(actor, user.id);
    const where = await this.baseWhere(caller, filter, options.kind, now);
    const rows = await this.prisma.approvalDeadline.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { openedAt: 'asc' }, { id: 'asc' }],
    });
    // canDecide reads source rows, so it is computed in batches over the SQL-filtered rows and the page is cut after it: the total is exact.
    const items: ApprovalItem[] = [];
    for (let at = 0; at < rows.length; at += BATCH_SIZE) {
      const batch = await this.hydrate(
        rows.slice(at, at + BATCH_SIZE),
        caller,
        now,
      );
      items.push(
        ...(filter === 'can_act'
          ? batch.filter((item) => item.canDecide)
          : batch),
      );
    }
    const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
    return {
      data: items.slice(
        (page - 1) * APPROVAL_PAGE_SIZE,
        page * APPROVAL_PAGE_SIZE,
      ),
      page,
      pageSize: APPROVAL_PAGE_SIZE,
      total: items.length,
    };
  }

  /** "Awaiting your action" counts only items the caller can decide; the overdue counter is per kind (02 §6.11). */
  async counts(user: RequestUser) {
    const actor = await this.staff(user);
    const now = new Date();
    const caller = callerOf(actor, user.id);
    const [actionable, overdue] = await Promise.all([
      this.prisma.approvalDeadline.findMany({
        where: await this.baseWhere(caller, 'can_act', undefined, now),
        orderBy: [{ dueAt: 'asc' }],
      }),
      this.prisma.approvalDeadline.groupBy({
        by: ['kind'],
        where: { closedAt: null, dueAt: { lte: now } },
        _count: { _all: true },
      }),
    ]);
    let canAct = 0;
    for (let at = 0; at < actionable.length; at += BATCH_SIZE) {
      const batch = await this.hydrate(
        actionable.slice(at, at + BATCH_SIZE),
        caller,
        now,
      );
      canAct += batch.filter((item) => item.canDecide).length;
    }
    return {
      canAct,
      overdueByKind: Object.fromEntries(
        overdue.map((group) => [group.kind, group._count._all]),
      ) as Record<string, number>,
    };
  }

  private async staff(user: RequestUser): Promise<ActorContext> {
    const actor = await this.actors.resolve(user.id);
    // 02 §11.4: any active staff member can read the queue; fields follow 02 §10.
    requireActiveStaff(actor);
    return actor;
  }

  /**
   * The rows the filter selects, in SQL: open items, narrowed by kind, by the
   * kinds the caller holds the permission for (`can_act`), by due time
   * (`overdue`) or by ownership and authorship (`mine`).
   */
  private async baseWhere(
    caller: Caller,
    filter: ApprovalFilter,
    kind: string | undefined,
    now: Date,
  ): Promise<Prisma.ApprovalDeadlineWhereInput> {
    const where: Prisma.ApprovalDeadlineWhereInput = { closedAt: null };
    const and: Prisma.ApprovalDeadlineWhereInput[] = [];
    if (kind) and.push({ kind });
    if (filter === 'overdue') and.push({ dueAt: { lte: now } });
    if (filter === 'can_act') {
      const kinds = Object.keys(APPROVAL_KINDS).filter((name) => {
        const permission = approvalKindSpec(name).permission;
        return (
          caller.permissions.has(permission) ||
          (name === 'cancellation' &&
            caller.permissions.has('request.cancel.active'))
        );
      });
      and.push({ kind: { in: kinds } });
    }
    if (filter === 'mine') and.push(await this.mineClause(caller.userId));
    return and.length ? { ...where, AND: and } : where;
  }

  /** 02 §6.11: "I own the request or I raised the item". */
  private async mineClause(
    userId: string,
  ): Promise<Prisma.ApprovalDeadlineWhereInput> {
    const [owned, escalations, refunds, payments, quotes] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where: { staffOwnerId: userId },
        select: { id: true },
      }),
      this.prisma.requestEscalation.findMany({
        where: { raisedBy: userId, resolvedAt: null },
        select: { id: true },
      }),
      this.prisma.refund.findMany({
        where: {
          requestedBy: userId,
          status: { in: ['pending_approval', 'awaiting_second_approval'] },
        },
        select: { id: true },
      }),
      this.prisma.payment.findMany({
        where: { recordedBy: userId, status: 'recorded' },
        select: { id: true },
      }),
      this.prisma.quote.findMany({
        where: { lastEditedBy: userId, approvalRequestedAt: { not: null } },
        select: { id: true },
      }),
    ]);
    const raised = [escalations, refunds, payments, quotes].flatMap((list) =>
      list.map(({ id }) => id),
    );
    return {
      OR: [
        { openedBy: userId },
        { requestId: { in: owned.map(({ id }) => id) } },
        { itemId: { in: raised } },
      ],
    };
  }

  private async hydrate(
    rows: ApprovalDeadline[],
    caller: Caller,
    now: Date,
  ): Promise<ApprovalItem[]> {
    const requestIds = [
      ...new Set(rows.flatMap((row) => (row.requestId ? [row.requestId] : []))),
    ];
    const idsOf = (kinds: string[]) =>
      rows.filter((row) => kinds.includes(row.kind)).map((row) => row.itemId);
    const providerIds = idsOf([
      'provider',
      'provider_changes',
      'provider_reliability',
      'bank',
    ]);
    const [
      requests,
      quotes,
      payments,
      refunds,
      payouts,
      escalations,
      cancellations,
      providers,
      approvers,
    ] = await Promise.all([
      requestIds.length
        ? this.prisma.serviceRequest.findMany({
            where: { id: { in: requestIds } },
            select: {
              id: true,
              number: true,
              title: true,
              ownerId: true,
              staffOwnerId: true,
              version: true,
            },
          })
        : [],
      when(idsOf(['quote_approval']), (ids) =>
        this.prisma.quote.findMany({
          where: { id: { in: ids } },
          select: { id: true, lastEditedBy: true },
        }),
      ),
      when(idsOf(['offline_payment']), (ids) =>
        this.prisma.payment.findMany({
          where: { id: { in: ids } },
          select: { id: true, recordedBy: true },
        }),
      ),
      when(idsOf(['refund']), (ids) =>
        this.prisma.refund.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            status: true,
            requestedBy: true,
            decidedBy: true,
            transferRecordedBy: true,
            version: true,
          },
        }),
      ),
      this.payouts(idsOf(['payout', 'payout_second'])),
      when(idsOf(['escalation']), (ids) =>
        this.prisma.requestEscalation.findMany({
          where: { id: { in: ids } },
          select: { id: true, target: true, raisedBy: true },
        }),
      ),
      when(idsOf(['cancellation']), (ids) =>
        this.prisma.cancellation.findMany({
          where: { id: { in: ids } },
          select: { id: true, paid: true, workStarted: true },
        }),
      ),
      providerIds.length
        ? this.prisma.providerProfile.findMany({
            where: { id: { in: providerIds } },
            select: {
              id: true,
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  name: true,
                  email: true,
                },
              },
            },
          })
        : [],
      rows.some((row) => row.kind === 'quote_approval')
        ? this.routing.holderIds('quote.approve')
        : [],
    ]);
    const requestById = new Map<string, RequestInfo>(
      requests.map((request) => [request.id, request]),
    );
    const ownerIds = [
      ...new Set(
        requests.flatMap((request) =>
          request.staffOwnerId ? [request.staffOwnerId] : [],
        ),
      ),
    ];
    const owners = ownerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            name: true,
            email: true,
          },
        })
      : [];
    const ownerName = new Map(
      owners.map((owner) => [owner.id, displayName(owner)]),
    );
    const providerName = new Map(
      providers.map((provider) => [provider.id, displayName(provider.user)]),
    );
    const by = <T extends { id: string }>(list: T[]) =>
      new Map(list.map((item) => [item.id, item]));
    const quoteById = by(quotes);
    const paymentById = by(payments);
    const refundById = by(refunds);
    const payoutById = by(payouts);
    const escalationById = by(escalations);
    const cancellationById = by(cancellations);

    return rows.map((row) => {
      const spec = approvalKindSpec(row.kind);
      const request = row.requestId
        ? requestById.get(row.requestId)
        : undefined;
      const facts: DecisionFacts = { requestOwnerId: request?.ownerId ?? null };
      let version: number | null = request?.version ?? null;
      const quote = quoteById.get(row.itemId);
      if (row.kind === 'quote_approval' && quote)
        facts.quote = {
          lastEditedBy: quote.lastEditedBy,
          otherApprovers: approvers.filter(
            (id) => id !== caller.userId && id !== quote.lastEditedBy,
          ).length,
        };
      const payment = paymentById.get(row.itemId);
      if (row.kind === 'offline_payment' && payment)
        facts.payment = { recordedBy: payment.recordedBy };
      const refund = refundById.get(row.itemId);
      if (row.kind === 'refund' && refund) {
        facts.refund = {
          status: refund.status,
          requestedBy: refund.requestedBy,
          decidedBy: refund.decidedBy,
          transferRecordedBy: refund.transferRecordedBy,
        };
        version = refund.version;
      }
      const payout = payoutById.get(row.itemId);
      if ((row.kind === 'payout' || row.kind === 'payout_second') && payout) {
        facts.payout = {
          approvals: payout.currentApprovals,
          bank: payout.bank,
        };
        version = payout.version;
      }
      const escalation = escalationById.get(row.itemId);
      if (row.kind === 'escalation' && escalation)
        facts.escalation = {
          to: escalation.target,
          raisedBy: escalation.raisedBy,
        };
      const cancellation = cancellationById.get(row.itemId);
      if (row.kind === 'cancellation' && cancellation)
        facts.cancellation = {
          paid: cancellation.paid,
          workStarted: cancellation.workStarted,
        };
      const decision = evaluateCanDecide({
        kind: row.kind,
        caller,
        facts,
        now,
      });
      return {
        id: row.id,
        kind: row.kind,
        label: spec.label,
        itemId: row.itemId,
        requestId: row.requestId,
        requestCode: request
          ? `XPR-${String(request.number).padStart(5, '0')}`
          : null,
        providerId: spec.scope === 'provider' ? row.itemId : null,
        title:
          request?.title ??
          (spec.scope === 'provider'
            ? (providerName.get(row.itemId) ?? 'Provider')
            : ''),
        ownerId: request?.staffOwnerId ?? null,
        ownerName: request?.staffOwnerId
          ? (ownerName.get(request.staffOwnerId) ?? null)
          : null,
        ...decision,
        createdAt: row.openedAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        remindAt: (row.remindAt ?? row.dueAt).toISOString(),
        state: approvalState(row, now),
        version,
      };
    });
  }

  private async payouts(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.prisma.payout.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        version: true,
        bankAccountId: true,
        approvals: { select: { step: true, actorId: true, bankVersion: true } },
      },
    });
    const bankIds = rows.flatMap((row) =>
      row.bankAccountId ? [row.bankAccountId] : [],
    );
    const banks = bankIds.length
      ? await this.prisma.providerBankAccount.findMany({
          where: { id: { in: bankIds } },
          select: {
            id: true,
            reviewedBy: true,
            reviewedAt: true,
            createdAt: true,
          },
        })
      : [];
    const bankById = new Map(banks.map((bank) => [bank.id, bank]));
    return rows.map((row) => {
      const bank = row.bankAccountId ? bankById.get(row.bankAccountId) : null;
      return {
        id: row.id,
        version: row.version,
        bank: bank
          ? { reviewedBy: bank.reviewedBy, reviewedAt: bank.reviewedAt }
          : null,
        currentApprovals: currentApprovals(
          row.approvals,
          bank ? bankVersionOf(bank) : null,
        ),
      };
    });
  }
}

const when = <T>(
  ids: string[],
  query: (ids: string[]) => Promise<T[]>,
): Promise<T[]> => (ids.length ? query(ids) : Promise.resolve([]));

function parseFilter(value: string | undefined): ApprovalFilter {
  if (value === undefined || value === '') return 'can_act';
  if ((APPROVAL_FILTERS as readonly string[]).includes(value))
    return value as ApprovalFilter;
  throw new AppError(
    422,
    'VALIDATION_ERROR',
    // new message: not in spec
    'Choose a valid approvals filter.',
  );
}

function callerOf(actor: ActorContext, userId: string): Caller {
  return {
    userId,
    permissions: actor.staff?.permissions ?? new Set<string>(),
    canOwn: actor.staff?.canOwn ?? false,
    isSuperAdmin: actor.staff?.isSuperAdmin ?? false,
  };
}

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
}): string {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
    user.name ||
    user.email
  );
}
