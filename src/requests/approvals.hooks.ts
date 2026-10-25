import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addWorkingMinutes } from '../platform/calendar/business-calendar';
import { SettingsService } from '../platform/settings/settings.service';

@Injectable()
export class ApprovalsHooks {
  constructor(private readonly settings: SettingsService) {}

  async open(
    tx: Prisma.TransactionClient,
    kind: string,
    itemId: string,
    requestId: string | null,
    now: Date,
    openedBy?: string | null,
  ): Promise<void> {
    const rows = await this.settings.snapshot();
    const settings = Object.fromEntries(
      rows.map(({ key, value }) => [key, value]),
    );
    const holidays = settings['calendar.holidays'] as string[] | undefined;
    const deadlines = settings['approvals.deadlines'] as
      Record<string, number> | undefined;
    const minutes = Number(deadlines?.[kind] ?? 240);
    const dueAt = addWorkingMinutes(now, minutes, holidays ?? []);
    const remindAt = addWorkingMinutes(
      now,
      Math.floor(minutes / 2),
      holidays ?? [],
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO approval_deadlines (id, kind, item_id, request_id, opened_at, started_at, deadline_working_minutes, remind_at, due_at, opened_by)
      VALUES (gen_random_uuid()::text, ${kind}, ${itemId}, ${requestId}, ${now}, ${now}, ${minutes}, ${remindAt}, ${dueAt}, ${openedBy ?? null})
      ON CONFLICT (kind, item_id) WHERE closed_at IS NULL DO UPDATE SET due_at = EXCLUDED.due_at, opened_at = EXCLUDED.opened_at, started_at = EXCLUDED.started_at, deadline_working_minutes = EXCLUDED.deadline_working_minutes, remind_at = EXCLUDED.remind_at, opened_by = EXCLUDED.opened_by
    `);
  }

  async close(
    tx: Prisma.TransactionClient,
    kind: string,
    itemId: string,
    now: Date,
    reason?: string,
  ): Promise<void> {
    await tx.approvalDeadline.updateMany({
      where: { kind, itemId, closedAt: null },
      data: { closedAt: now, closedReason: reason ?? null },
    });
  }

  async onSubmitted(
    tx: Prisma.TransactionClient,
    requestId: string,
    now: Date,
  ): Promise<void> {
    await this.open(tx, 'intake', requestId, requestId, now);
  }
}
