import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SETTINGS_REGISTRY } from '../platform/settings/settings.registry';
import { STAFF_PERMISSIONS } from '../staff/staff-permissions';
import {
  APPROVAL_KINDS,
  approvalClock,
  approvalKindSpec,
  ApprovalsHooks,
  deadlineMinutes,
} from './approvals.hooks';

const wat = (local: string) => new Date(`${local}:00+01:00`);
const iso = (date: Date) => date.toISOString();

// 02 §6.11: the kinds the table lists, plus the two the plan adds for lapsed quotes and payments.
const SPEC_KINDS = [
  'unclaimed',
  'intake',
  'clarification_overdue',
  'needs_assignment',
  'assignment',
  'no_show',
  'quote_build',
  'quote_approval',
  'quote_followup',
  'schedule_needed',
  'schedule_change',
  'progress',
  'blocker',
  'completion',
  'completion_issue',
  'cancellation',
  'ready_to_close',
  'escalation',
  'provider',
  'provider_changes',
  'provider_reliability',
  'bank',
  'offline_payment',
  'refund',
  'payout',
  'payout_second',
  'compensation',
  'quote_expired',
  'payment_lapsed',
];
// Opened by modules this plan doesn't build: provider verification and bank review (spec 03) and compensation payouts (05).
const PLANNED = ['provider', 'provider_changes', 'bank', 'compensation'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(spec|int-spec|testkit)\.ts$/.test(name)
      ? [path]
      : [];
  });
}
const SOURCE = sourceFiles(join(__dirname, '..'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

describe('the approval kind map (plan C.5)', () => {
  it('covers every 02 §6.11 kind and nothing else', () => {
    expect(Object.keys(APPROVAL_KINDS).sort()).toEqual([...SPEC_KINDS].sort());
  });

  it('has a deadline default for every kind', () => {
    const defaults = SETTINGS_REGISTRY['approvals.deadlines']
      .defaultValue as Record<string, number>;
    expect(Object.keys(defaults).sort()).toEqual([...SPEC_KINDS].sort());
  });

  it('names a real deciding permission for every kind', () => {
    for (const kind of SPEC_KINDS)
      expect(STAFF_PERMISSIONS).toContain(approvalKindSpec(kind).permission);
  });

  it.each(SPEC_KINDS.filter((kind) => !PLANNED.includes(kind)))(
    '%s has source commands that open and close it, and the code does both',
    (kind) => {
      const spec = approvalKindSpec(kind);
      expect(spec.opens.length).toBeGreaterThan(0);
      expect(spec.closes.length).toBeGreaterThan(0);
      // `completion` items are opened and closed through reviewItemKind(update.kind).
      const viaUpdateKind =
        kind === 'completion' && /reviewItemKind\(/.test(SOURCE);
      const literalOpen = new RegExp(
        `approvals\\.open\\(\\s*'${kind}'|deadlines\\.open\\(\\s*'${kind}'`,
      );
      const literalClose = new RegExp(`approvals\\.close\\(\\s*'${kind}'`);
      const listedClose = new RegExp(
        `closeOpenApprovals\\([^;]*?\\[[^\\]]*'${kind}'`,
      );
      expect(literalOpen.test(SOURCE) || viaUpdateKind).toBe(true);
      expect(
        literalClose.test(SOURCE) || listedClose.test(SOURCE) || viaUpdateKind,
      ).toBe(true);
    },
  );

  it('lists exactly the planned kinds as not yet opened by any command', () => {
    const planned = Object.entries(APPROVAL_KINDS)
      .filter(([, spec]) => 'planned' in spec && spec.planned)
      .map(([kind]) => kind);
    expect(planned.sort()).toEqual([...PLANNED].sort());
  });
});

describe('deadline defaults', () => {
  it('gives quote_expired and payment_lapsed 8 working hours', () => {
    expect(deadlineMinutes({}, 'quote_expired')).toBe(480);
    expect(deadlineMinutes({}, 'payment_lapsed')).toBe(480);
  });

  it('reads a stored value over the default, and the default for a kind stored settings predate', () => {
    const stored = { 'approvals.deadlines': { intake: 30 } };
    expect(deadlineMinutes(stored, 'intake')).toBe(30);
    expect(deadlineMinutes(stored, 'quote_expired')).toBe(480);
  });

  it('fails loudly for an unknown kind instead of defaulting to 240', () => {
    expect(() => deadlineMinutes({}, 'made_up')).toThrow(
      'Unknown approval kind: made_up',
    );
    expect(() => approvalKindSpec('made_up')).toThrow();
  });
});

describe('approvalClock (working time across a weekend)', () => {
  it('runs a Friday 17:00 item into Monday: 4 h is due Monday 11:00, the 50% reminder Monday 09:00', () => {
    const clock = approvalClock(wat('2026-10-23T17:00'), 240);
    expect(iso(clock.startedAt)).toBe(iso(wat('2026-10-23T17:00')));
    expect(iso(clock.remindAt)).toBe(iso(wat('2026-10-26T09:00')));
    expect(iso(clock.dueAt)).toBe(iso(wat('2026-10-26T11:00')));
  });

  it('starts an item created on Saturday at the next working minute, Monday 08:00', () => {
    const clock = approvalClock(wat('2026-10-24T12:00'), 120);
    expect(iso(clock.startedAt)).toBe(iso(wat('2026-10-26T08:00')));
    expect(iso(clock.remindAt)).toBe(iso(wat('2026-10-26T09:00')));
    expect(iso(clock.dueAt)).toBe(iso(wat('2026-10-26T10:00')));
  });

  it('skips a public holiday', () => {
    const clock = approvalClock(wat('2026-10-23T17:00'), 240, ['2026-10-26']);
    expect(iso(clock.dueAt)).toBe(iso(wat('2026-10-27T11:00')));
  });

  it('counts a 20-hour provider deadline as two working days', () => {
    const clock = approvalClock(wat('2026-10-23T09:00'), 1200);
    expect(iso(clock.dueAt)).toBe(iso(wat('2026-10-27T09:00')));
  });
});

describe('ApprovalsHooks', () => {
  const now = wat('2026-10-26T10:00');
  const settings = {
    snapshot: jest.fn().mockResolvedValue([]),
  };
  const build = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      approvalDeadline: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { tx, hooks: new ApprovalsHooks(settings as never) };
  };
  const sqlOf = (tx: { $executeRaw: jest.Mock }) =>
    (tx.$executeRaw.mock.calls[0] as [{ strings: string[] }])[0].strings.join(
      '?',
    );
  const valuesOf = (tx: { $executeRaw: jest.Mock }) =>
    (tx.$executeRaw.mock.calls[0] as [{ values: unknown[] }])[0].values;

  it('does not reset the clock of an item that is already open', async () => {
    const { tx, hooks } = build();

    await hooks.open(tx as never, 'cancellation', 'c-1', 'request-1', now);

    const sql = sqlOf(tx);
    expect(sql).toContain(
      'ON CONFLICT (kind, item_id) WHERE closed_at IS NULL',
    );
    expect(sql).toContain('DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE/);
  });

  it('writes the 02 §6.11 deadline columns', async () => {
    const { tx, hooks } = build();

    await hooks.open(
      tx as never,
      'intake',
      'request-1',
      'request-1',
      now,
      'u-1',
    );

    const values = valuesOf(tx);
    expect(values).toContain(240);
    expect(
      values.map((value) => (value instanceof Date ? iso(value) : value)),
    ).toEqual(
      expect.arrayContaining([
        'intake',
        'request-1',
        iso(now),
        iso(wat('2026-10-26T12:00')),
        iso(wat('2026-10-26T14:00')),
        'u-1',
      ]),
    );
  });

  it('stores no request for a provider-scope item', async () => {
    const { tx, hooks } = build();

    await hooks.open(
      tx as never,
      'provider_reliability',
      'provider-1',
      'request-1',
      now,
    );

    expect(valuesOf(tx)).not.toContain('request-1');
    expect(valuesOf(tx)).toContain('provider-1');
  });

  it('refuses a kind that is not in the map', async () => {
    const { tx, hooks } = build();

    await expect(
      hooks.open(tx as never, 'made_up', 'x', null, now),
    ).rejects.toThrow('Unknown approval kind: made_up');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('closes an item with the reason', async () => {
    const { tx, hooks } = build();

    await hooks.close(tx as never, 'intake', 'request-1', now, 'approved');

    expect(tx.approvalDeadline.updateMany).toHaveBeenCalledWith({
      where: { kind: 'intake', itemId: 'request-1', closedAt: null },
      data: { closedAt: now, closedReason: 'approved' },
    });
  });
});
