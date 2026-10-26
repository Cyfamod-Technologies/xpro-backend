import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addWorkingMinutes,
  nextWorkingMinute,
} from '../platform/calendar/business-calendar';
import { SETTINGS_REGISTRY } from '../platform/settings/settings.registry';
import { SettingsService } from '../platform/settings/settings.service';
import type { StaffPermission } from '../staff/staff-permissions';

/**
 * The separation-of-duties rule that can block a caller who holds the kind's
 * permission (02 §6.14). `canDecide` in the approvals queue applies it.
 */
export type SeparationRule =
  | 'none'
  | 'quote_last_editor'
  | 'recorder_not_reconciler'
  | 'requester_not_decider'
  | 'bank_change'
  | 'first_not_second_approver'
  | 'raiser_not_resolver';

export type ApprovalKindSpec = {
  /** The label of 02 §6.11, used in reminder and overdue notices. */
  label: string;
  /** The permission that decides the item. */
  permission: StaffPermission;
  /** `request` items belong to a request; `provider` items belong to a provider profile. */
  scope: 'request' | 'provider';
  separation: SeparationRule;
  /** Source commands that open the item. */
  opens: readonly string[];
  /** Commands that resolve the item. A closed or cancelled request also closes every non-money item. */
  closes: readonly string[];
  /** Opened by a module that isn't built yet (spec 03 provider work, or compensation payouts). */
  planned?: boolean;
};

const REQUEST_ENDS = ['request.reject', 'request.cancel', 'request.close'];

/**
 * One table for every approval kind: its deciding permission, separation rule,
 * and the commands that open and close it (02 §6.11, plan C.5). The
 * `approvals.deadlines` setting carries the deadline of each kind.
 */
export const APPROVAL_KINDS = {
  unclaimed: {
    label: 'Needs an owner',
    permission: 'request.claim',
    scope: 'request',
    separation: 'none',
    opens: ['request.create', 'request.release'],
    closes: [
      'request.claim',
      'request.reassign',
      'auto-claim',
      'request.reject',
      'request.cancel',
    ],
  },
  intake: {
    label: 'Intake review',
    permission: 'request.review',
    scope: 'request',
    separation: 'none',
    opens: ['request.create', 'request.update', 'message.send'],
    closes: ['request.review', 'request.clarify', ...REQUEST_ENDS],
  },
  clarification_overdue: {
    label: 'Clarification unanswered',
    permission: 'request.clarify',
    scope: 'request',
    separation: 'none',
    opens: ['timer.T6.staff5d'],
    closes: [
      'request.update',
      'message.send',
      'request.review',
      'request.clarify',
      ...REQUEST_ENDS,
    ],
  },
  needs_assignment: {
    label: 'Needs manual assignment',
    permission: 'dispatch.manage',
    scope: 'request',
    separation: 'none',
    opens: [
      'request.review',
      'assignment.review',
      'assignment.withdraw',
      'assignment.replace',
      'timer.T1.expire',
      'timer.dispatch.cascade',
      'dispatch.auto',
      'provider.standingChanged',
    ],
    closes: [
      'assignment.offer',
      'assignment.auto',
      'assignment.review',
      ...REQUEST_ENDS,
    ],
  },
  assignment: {
    label: 'Provider acceptance',
    permission: 'dispatch.manage',
    scope: 'request',
    separation: 'none',
    opens: ['assignment.respond'],
    closes: [
      'assignment.review',
      'assignment.withdraw',
      'assignment.replace',
      ...REQUEST_ENDS,
    ],
  },
  no_show: {
    label: 'Provider no-show',
    permission: 'dispatch.manage',
    scope: 'request',
    separation: 'none',
    opens: ['timer.T13.noShowCheck', 'noshow.record'],
    closes: [
      'noshow.confirm',
      'noshow.dismiss',
      'progress.review',
      'assignment.withdraw',
      'assignment.replace',
      ...REQUEST_ENDS,
    ],
  },
  quote_build: {
    label: 'Quote to build',
    permission: 'quote.manage',
    scope: 'request',
    separation: 'none',
    opens: ['quote.contribute', 'quote.return'],
    closes: [
      'quote.publish',
      'quote.approve',
      'assignment.withdraw',
      'assignment.replace',
      ...REQUEST_ENDS,
    ],
  },
  quote_approval: {
    label: 'Quote sign-off',
    permission: 'quote.approve',
    scope: 'request',
    separation: 'quote_last_editor',
    opens: ['quote.publish'],
    closes: [
      'quote.approve',
      'quote.return',
      'quote.save',
      'assignment.withdraw',
      'assignment.replace',
      ...REQUEST_ENDS,
    ],
  },
  quote_followup: {
    label: 'Quote revision',
    permission: 'quote.manage',
    scope: 'request',
    separation: 'none',
    opens: ['quote.respond', 'cancellation.decide'],
    closes: ['quote.publish', 'quote.approve', ...REQUEST_ENDS],
  },
  quote_expired: {
    label: 'Quote expired',
    permission: 'quote.manage',
    scope: 'request',
    separation: 'none',
    opens: ['timer.T8.expire'],
    closes: ['quote.publish', 'quote.approve', ...REQUEST_ENDS],
  },
  payment_lapsed: {
    label: 'Payment lapsed',
    permission: 'quote.manage',
    scope: 'request',
    separation: 'none',
    opens: ['timer.T9.lapse'],
    closes: ['quote.publish', 'quote.approve', ...REQUEST_ENDS],
  },
  schedule_needed: {
    label: 'Schedule it',
    permission: 'schedule.manage',
    scope: 'request',
    separation: 'none',
    opens: ['payment.settled', 'assignment.review'],
    closes: ['schedule.propose', ...REQUEST_ENDS],
  },
  schedule_change: {
    label: 'Schedule change requested',
    permission: 'schedule.manage',
    scope: 'request',
    separation: 'none',
    opens: [
      'schedule.respond',
      'schedule.requestChange',
      'timer.T11.staff48h',
      'provider.hoursChanged',
    ],
    closes: ['schedule.propose', 'schedule.respond', ...REQUEST_ENDS],
  },
  progress: {
    label: 'Progress update',
    permission: 'progress.review',
    scope: 'request',
    separation: 'none',
    opens: ['progress.add', 'timer.T15.stale'],
    closes: [
      'progress.review',
      'progress.add',
      'request.hold',
      ...REQUEST_ENDS,
    ],
  },
  blocker: {
    label: 'Blocker update',
    permission: 'progress.review',
    scope: 'request',
    separation: 'none',
    opens: ['progress.add', 'timer.T16.review'],
    closes: ['progress.review', 'request.releaseHold', ...REQUEST_ENDS],
  },
  completion: {
    label: 'Completion report',
    permission: 'progress.review',
    scope: 'request',
    separation: 'none',
    opens: ['progress.add'],
    closes: ['progress.review', ...REQUEST_ENDS],
  },
  completion_issue: {
    label: 'Completion issue',
    permission: 'issue.resolve',
    scope: 'request',
    separation: 'none',
    opens: ['completion.respond', 'issue.raise'],
    closes: ['issue.accept', 'issue.resolve', ...REQUEST_ENDS],
  },
  cancellation: {
    label: 'Cancellation request',
    permission: 'request.cancel',
    scope: 'request',
    separation: 'none',
    opens: ['cancellation.request', 'quote.respond', 'timer.T19.followup'],
    closes: ['cancellation.decide', 'cancellation.withdraw', ...REQUEST_ENDS],
  },
  ready_to_close: {
    label: 'Ready to close',
    permission: 'request.close',
    scope: 'request',
    separation: 'none',
    opens: ['timer.T21.defectsEnd'],
    closes: ['issue.raise', ...REQUEST_ENDS],
  },
  escalation: {
    label: 'Escalation',
    permission: 'request.escalation.resolve',
    scope: 'request',
    separation: 'raiser_not_resolver',
    opens: [
      'request.escalate',
      'issue.escalate',
      'completion.respond',
      'timer.T15.escalate',
      'provider.standingChanged',
      'customer.suspended',
    ],
    closes: ['request.escalation.resolve', 'issue.resolve', ...REQUEST_ENDS],
  },
  provider: {
    label: 'Provider verification',
    permission: 'provider.review',
    scope: 'provider',
    separation: 'none',
    opens: [],
    closes: [],
    planned: true,
  },
  provider_changes: {
    label: 'Profile changes',
    permission: 'provider.review',
    scope: 'provider',
    separation: 'none',
    opens: [],
    closes: [],
    planned: true,
  },
  provider_reliability: {
    label: 'Reliability review',
    permission: 'provider.review',
    scope: 'provider',
    separation: 'none',
    opens: ['noshow.confirm'],
    closes: ['noshow.correct'],
  },
  bank: {
    label: 'Bank details',
    permission: 'bank.review',
    scope: 'provider',
    separation: 'none',
    opens: [],
    closes: [],
    planned: true,
  },
  offline_payment: {
    label: 'Offline payment to reconcile',
    permission: 'payment.record',
    scope: 'request',
    separation: 'recorder_not_reconciler',
    opens: ['payment.recordOffline'],
    closes: ['payment.reconcile', 'payment.reject'],
  },
  refund: {
    label: 'Refund decision',
    permission: 'refund.manage',
    scope: 'request',
    separation: 'requester_not_decider',
    opens: ['refund.request', 'cancellation.decide', 'payment.settled'],
    closes: ['refund.decide', 'refund.reconcile', 'refund.process'],
  },
  payout: {
    label: 'Payout approval',
    permission: 'payout.approve',
    scope: 'request',
    separation: 'bank_change',
    opens: [
      'completion.respond',
      'completion.confirmOnBehalf',
      'timer.T17.autoConfirm',
    ],
    closes: ['payout.approve', 'payout.hold', 'payout.transfer'],
  },
  payout_second: {
    label: 'Payout second approval',
    permission: 'payout.approve',
    scope: 'request',
    separation: 'first_not_second_approver',
    opens: ['payout.approve'],
    closes: ['payout.approve', 'payout.hold', 'payout.transfer'],
  },
  compensation: {
    label: 'Compensation decision',
    permission: 'payout.approve',
    scope: 'request',
    separation: 'none',
    opens: [],
    closes: [],
    planned: true,
  },
} as const satisfies Record<string, ApprovalKindSpec>;

export type ApprovalKind = keyof typeof APPROVAL_KINDS;

export function approvalKindSpec(kind: string): ApprovalKindSpec {
  const spec = (APPROVAL_KINDS as Record<string, ApprovalKindSpec>)[kind];
  if (!spec) throw new Error(`Unknown approval kind: ${kind}`);
  return spec;
}

/** The setting's stored value over its defaults, so a deployment stored before a kind existed still resolves it. */
export function deadlineMinutes(
  settings: Readonly<Record<string, unknown>>,
  kind: string,
): number {
  approvalKindSpec(kind);
  const defaults = SETTINGS_REGISTRY['approvals.deadlines']
    .defaultValue as Record<string, number>;
  const stored = settings['approvals.deadlines'];
  const merged = {
    ...defaults,
    ...(stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, number>)
      : {}),
  };
  const minutes = Number(merged[kind]);
  if (!Number.isFinite(minutes) || minutes < 0)
    throw new Error(`No deadline is configured for approval kind: ${kind}`);
  return minutes;
}

/**
 * The clock of an item (02 §6.11): it starts at the next working minute and
 * runs in working time. The reminder is due at 50% of the deadline.
 */
export function approvalClock(
  now: Date,
  minutes: number,
  holidays: readonly string[] = [],
): { startedAt: Date; remindAt: Date; dueAt: Date } {
  return {
    startedAt: nextWorkingMinute(now, holidays),
    remindAt: addWorkingMinutes(now, Math.floor(minutes / 2), holidays),
    dueAt: addWorkingMinutes(now, minutes, holidays),
  };
}

@Injectable()
export class ApprovalsHooks {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Starts the clock of an item. An item that is already open keeps its clock:
   * a second open of the same `(kind, itemId)` changes nothing.
   */
  async open(
    tx: Prisma.TransactionClient,
    kind: string,
    itemId: string,
    requestId: string | null,
    now: Date,
    openedBy?: string | null,
  ): Promise<void> {
    const spec = approvalKindSpec(kind);
    const rows = await this.settings.snapshot();
    const settings = Object.fromEntries(
      rows.map(({ key, value }) => [key, value]),
    );
    const holidays =
      (settings['calendar.holidays'] as string[] | undefined) ?? [];
    const minutes = deadlineMinutes(settings, kind);
    const { startedAt, remindAt, dueAt } = approvalClock(
      now,
      minutes,
      holidays,
    );
    const owner = spec.scope === 'provider' ? null : requestId;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO approval_deadlines (id, kind, item_id, request_id, opened_at, started_at, deadline_working_minutes, remind_at, due_at, opened_by)
      VALUES (gen_random_uuid()::text, ${kind}, ${itemId}, ${owner}, ${now}, ${startedAt}, ${minutes}, ${remindAt}, ${dueAt}, ${openedBy ?? null})
      ON CONFLICT (kind, item_id) WHERE closed_at IS NULL DO NOTHING
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
}
