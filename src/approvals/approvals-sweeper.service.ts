import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ApprovalDeadline } from '@prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { StaffRoutingService } from '../notifications/staff-routing.service';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { PrismaService } from '../prisma/prisma.service';
import { approvalKindSpec } from '../requests/approvals.hooks';

const BATCH_SIZE = 100;
const WORKING_DAY_MINUTES = 600;

/** "45 min", "4 h", "1 h 30 min", "2 working days" (a working day is 10 hours, 02 §6.11). */
export function formatWorkingDuration(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) return `${total} min`;
  if (total >= WORKING_DAY_MINUTES && total % WORKING_DAY_MINUTES === 0) {
    const days = total / WORKING_DAY_MINUTES;
    return `${days} working day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

type Described = {
  requestId: string | null;
  code: string;
  title: string;
  staffOwnerId: string | null;
  link: string;
};

/**
 * Reminders at 50% and escalation at 100% of every open approval item (02
 * §6.11). It runs on the timers' 60-second sweep. Each notice is claimed with
 * a conditional update on `remindedAt` / `escalatedAt IS NULL` in the same
 * transaction as its notifications, so concurrent sweeps send one each and a
 * failed send is retried on the next sweep.
 */
@Injectable()
export class ApprovalsSweeper implements OnModuleInit {
  private readonly logger = new Logger(ApprovalsSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TimerRegistry,
    private readonly dispatcher: NotificationDispatcher,
    private readonly routing: StaffRoutingService,
  ) {}

  onModuleInit(): void {
    this.registry.registerSweeper(async (now) => {
      await this.sweep(now);
    });
  }

  async sweep(now: Date): Promise<{ reminded: number; escalated: number }> {
    const reminded = await this.run('remind', now);
    const escalated = await this.run('escalate', now);
    return { reminded, escalated };
  }

  private async run(step: 'remind' | 'escalate', now: Date): Promise<number> {
    const rows = await this.prisma.approvalDeadline.findMany({
      where:
        step === 'remind'
          ? { closedAt: null, remindedAt: null, remindAt: { lte: now } }
          : { closedAt: null, escalatedAt: null, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (!rows.length) return 0;
    const described = await this.describe(rows);
    let sent = 0;
    for (const row of rows) {
      try {
        if (await this.process(step, row, described.get(row.id)!, now))
          sent += 1;
      } catch (error) {
        this.logger.error(
          `Approval ${step} for ${row.kind} ${row.itemId} failed: ${String(error)}`,
        );
      }
    }
    return sent;
  }

  private process(
    step: 'remind' | 'escalate',
    row: ApprovalDeadline,
    item: Described,
    now: Date,
  ): Promise<boolean> {
    const spec = approvalKindSpec(row.kind);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.approvalDeadline.updateMany({
        where:
          step === 'remind'
            ? { id: row.id, closedAt: null, remindedAt: null }
            : { id: row.id, closedAt: null, escalatedAt: null },
        data: step === 'remind' ? { remindedAt: now } : { escalatedAt: now },
      });
      if (claimed.count !== 1) return false;
      if (step === 'remind') {
        // An item that is already overdue has nothing left to be reminded of.
        if (row.dueAt <= now) return true;
        const minutes = row.deadlineWorkingMinutes ?? 0;
        const recipients = await this.routing.audience(
          item.requestId ? 'gated' : 'gated_unscoped',
          {
            requestId: item.requestId,
            ownerId: item.staffOwnerId,
            actorId: null,
            permission: spec.permission,
          },
        );
        await this.dispatcher.dispatchDirect(
          tx,
          'approval.reminder',
          {
            label: spec.label,
            due: formatWorkingDuration(minutes - Math.floor(minutes / 2)),
            code: item.code,
            title: item.title,
            link: item.link,
          },
          recipients,
          item.requestId,
        );
        return true;
      }
      const [holders, superAdmins] = await Promise.all([
        this.routing.audience('all_holders', {
          requestId: item.requestId,
          ownerId: item.staffOwnerId,
          actorId: null,
          permission: spec.permission,
        }),
        this.routing.audience('super_admins', {
          requestId: item.requestId,
          ownerId: item.staffOwnerId,
          actorId: null,
        }),
      ]);
      await this.dispatcher.dispatchDirect(
        tx,
        'approval.overdue',
        {
          label: spec.label,
          code: item.code,
          title: item.title,
          link: item.link,
        },
        [...holders, ...superAdmins],
        item.requestId,
      );
      return true;
    });
  }

  private async describe(
    rows: ApprovalDeadline[],
  ): Promise<Map<string, Described>> {
    const requestIds = [
      ...new Set(rows.flatMap((row) => (row.requestId ? [row.requestId] : []))),
    ];
    const providerIds = rows
      .filter((row) => approvalKindSpec(row.kind).scope === 'provider')
      .map((row) => row.itemId);
    const [requests, providers] = await Promise.all([
      requestIds.length
        ? this.prisma.serviceRequest.findMany({
            where: { id: { in: requestIds } },
            select: { id: true, number: true, title: true, staffOwnerId: true },
          })
        : [],
      providerIds.length
        ? this.prisma.providerProfile.findMany({
            where: { id: { in: providerIds } },
            select: {
              id: true,
              user: {
                select: { firstName: true, lastName: true, email: true },
              },
            },
          })
        : [],
    ]);
    const requestById = new Map(requests.map((item) => [item.id, item]));
    const providerById = new Map(providers.map((item) => [item.id, item]));
    return new Map<string, Described>(
      rows.map((row): [string, Described] => {
        const request = row.requestId ? requestById.get(row.requestId) : null;
        if (request) {
          const code = `XPR-${String(request.number).padStart(5, '0')}`;
          return [
            row.id,
            {
              requestId: request.id,
              code,
              title: request.title,
              staffOwnerId: request.staffOwnerId,
              link: `/requests/${code}`,
            },
          ];
        }
        const provider = providerById.get(row.itemId);
        const name = provider
          ? [provider.user.firstName, provider.user.lastName]
              .filter(Boolean)
              .join(' ')
              .trim() || provider.user.email
          : 'Provider';
        return [
          row.id,
          {
            requestId: null,
            code: row.itemId,
            title: name,
            staffOwnerId: null,
            link: '/admin/approvals',
          },
        ];
      }),
    );
  }
}
