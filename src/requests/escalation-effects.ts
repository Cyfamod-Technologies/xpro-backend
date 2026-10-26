import type { CommandContext } from './command-runner';

export type EscalationTarget = 'operations' | 'super_admin';

type EscalationContext = Pick<
  CommandContext,
  'tx' | 'snap' | 'now' | 'audit' | 'notify' | 'approvals'
>;

/**
 * Opens an escalation on the request (02 §6.10): the row, its `escalation`
 * queue item (2 working hours), the audit entry and the "Escalation raised"
 * notice (the owner or the holders of `request.escalation.resolve` for
 * operations, every active super admin for `super_admin`). Returns `null`
 * without writing when the request already has an open escalation to that
 * target, so system triggers can call it without checking first.
 */
export async function openEscalation(
  ctx: EscalationContext,
  input: {
    to: EscalationTarget;
    note: string;
    source: 'staff' | 'system';
    raisedBy?: string | null;
  },
): Promise<string | null> {
  const existing = await ctx.tx.requestEscalation.findFirst({
    where: { requestId: ctx.snap.id, target: input.to, resolvedAt: null },
    select: { id: true },
  });
  if (existing) return null;
  const note = input.note.trim();
  const row = await ctx.tx.requestEscalation.create({
    data: {
      requestId: ctx.snap.id,
      target: input.to,
      source: input.source,
      note,
      raisedBy: input.raisedBy ?? null,
      raisedAt: ctx.now,
    },
  });
  ctx.approvals.open('escalation', row.id);
  const request = await ctx.tx.serviceRequest.findUnique({
    where: { id: ctx.snap.id },
    select: { title: true },
  });
  ctx.audit('request.escalated', {
    resourceType: 'request_escalation',
    resourceId: row.id,
    note,
    changes: { to: input.to, source: input.source },
  });
  ctx.notify(
    input.to === 'super_admin'
      ? 'escalation.raised_super_admin'
      : 'escalation.raised',
    { requestCode: ctx.snap.number, title: request?.title ?? '', note },
  );
  return row.id;
}
