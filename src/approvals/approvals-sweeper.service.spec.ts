import type { ApprovalDeadline } from '@prisma/client';
import { TimerRegistry } from '../platform/timers/timer-registry';
import {
  ApprovalsSweeper,
  formatWorkingDuration,
} from './approvals-sweeper.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const HOUR = 60 * 60_000;

const item = (patch: Partial<ApprovalDeadline> = {}): ApprovalDeadline => ({
  id: 'row-1',
  kind: 'intake',
  itemId: 'r1',
  requestId: 'r1',
  openedAt: new Date(NOW.getTime() - 3 * HOUR),
  startedAt: new Date(NOW.getTime() - 3 * HOUR),
  deadlineWorkingMinutes: 240,
  remindAt: new Date(NOW.getTime() - HOUR),
  dueAt: new Date(NOW.getTime() + HOUR),
  remindedAt: null,
  escalatedAt: null,
  closedAt: null,
  closedReason: null,
  openedBy: null,
  createdAt: NOW,
  ...patch,
});

function setup(rows: ApprovalDeadline[], claims: number[] = [1]) {
  const tx = {
    approvalDeadline: {
      updateMany: jest.fn(),
    },
  };
  claims.forEach((count) =>
    tx.approvalDeadline.updateMany.mockResolvedValueOnce({ count }),
  );
  const prisma = {
    approvalDeadline: { findMany: jest.fn() },
    serviceRequest: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'r1',
          number: 42,
          title: 'Roof repair',
          staffOwnerId: 'owner-1',
        },
      ]),
    },
    providerProfile: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p1',
          user: { firstName: 'Pat', lastName: 'Pro', email: 'p@x' },
        },
      ]),
    },
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
  };
  // The reminder pass sees the rows first, the escalation pass second.
  prisma.approvalDeadline.findMany.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('remindedAt' in where ? rows : []),
  );
  const dispatcher = { dispatchDirect: jest.fn().mockResolvedValue(undefined) };
  const routing = {
    audience: jest.fn((rule: string) =>
      Promise.resolve(
        {
          gated: ['owner-1'],
          gated_unscoped: ['holder-1'],
          all_holders: ['holder-1', 'admin-1'],
          super_admins: ['admin-1', 'admin-2'],
        }[rule] ?? [],
      ),
    ),
  };
  const registry = new TimerRegistry();
  const sweeper = new ApprovalsSweeper(
    prisma as never,
    registry,
    dispatcher as never,
    routing as never,
  );
  return { sweeper, prisma, tx, dispatcher, routing, registry };
}

describe('ApprovalsSweeper', () => {
  it('registers itself on the timers sweep', () => {
    const { sweeper, registry } = setup([]);
    sweeper.onModuleInit();
    expect(registry.sweepHandlers()).toHaveLength(1);
  });

  describe('reminder at 50%', () => {
    it('selects open rows past remindAt that were not reminded, and claims each one conditionally', async () => {
      const { sweeper, prisma, tx } = setup([item()]);

      await sweeper.sweep(NOW);

      expect(prisma.approvalDeadline.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { closedAt: null, remindedAt: null, remindAt: { lte: NOW } },
        }),
      );
      expect(tx.approvalDeadline.updateMany).toHaveBeenCalledWith({
        where: { id: 'row-1', closedAt: null, remindedAt: null },
        data: { remindedAt: NOW },
      });
    });

    it('sends "Reminder: {label} due in {time}" to the routing audience, the owner first', async () => {
      const { sweeper, dispatcher, routing, tx } = setup([item()]);

      await expect(sweeper.sweep(NOW)).resolves.toEqual({
        reminded: 1,
        escalated: 0,
      });

      expect(routing.audience).toHaveBeenCalledWith('gated', {
        requestId: 'r1',
        ownerId: 'owner-1',
        actorId: null,
        permission: 'request.review',
      });
      expect(dispatcher.dispatchDirect).toHaveBeenCalledWith(
        tx,
        'approval.reminder',
        {
          label: 'Intake review',
          due: '2 h',
          code: 'XPR-00042',
          title: 'Roof repair',
          link: '/requests/XPR-00042',
        },
        ['owner-1'],
        'r1',
      );
    });

    it('routes a provider item to the holders of the permission, with no request', async () => {
      const { sweeper, dispatcher, routing } = setup([
        item({
          kind: 'provider_reliability',
          itemId: 'p1',
          requestId: null,
          deadlineWorkingMinutes: 1200,
        }),
      ]);

      await sweeper.sweep(NOW);

      expect(routing.audience).toHaveBeenCalledWith(
        'gated_unscoped',
        expect.objectContaining({
          requestId: null,
          permission: 'provider.review',
        }),
      );
      expect(dispatcher.dispatchDirect).toHaveBeenCalledWith(
        expect.anything(),
        'approval.reminder',
        expect.objectContaining({
          label: 'Reliability review',
          due: '1 working day',
          title: 'Pat Pro',
        }),
        ['holder-1'],
        null,
      );
    });

    it('claims once: a sweep that loses the claim sends nothing', async () => {
      const { sweeper, dispatcher } = setup([item()], [0]);

      await expect(sweeper.sweep(NOW)).resolves.toEqual({
        reminded: 0,
        escalated: 0,
      });

      expect(dispatcher.dispatchDirect).not.toHaveBeenCalled();
    });

    it('marks an already-overdue item reminded without a "due in" notice', async () => {
      const { sweeper, dispatcher, tx } = setup([
        item({ dueAt: new Date(NOW.getTime() - 1) }),
      ]);

      await sweeper.sweep(NOW);

      expect(tx.approvalDeadline.updateMany).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatchDirect).not.toHaveBeenCalled();
    });
  });

  describe('escalation at 100%', () => {
    const overdue = () => item({ dueAt: new Date(NOW.getTime() - HOUR) });
    const setupOverdue = (claims = [1]) => {
      const kit = setup([], claims);
      kit.prisma.approvalDeadline.findMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve('escalatedAt' in where ? [overdue()] : []),
      );
      return kit;
    };

    it('claims on escalatedAt IS NULL and sends "Overdue: {label} · {id} · {title}" to holders and every super admin', async () => {
      const { sweeper, prisma, tx, dispatcher } = setupOverdue();

      await expect(sweeper.sweep(NOW)).resolves.toEqual({
        reminded: 0,
        escalated: 1,
      });

      expect(prisma.approvalDeadline.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { closedAt: null, escalatedAt: null, dueAt: { lte: NOW } },
        }),
      );
      expect(tx.approvalDeadline.updateMany).toHaveBeenCalledWith({
        where: { id: 'row-1', closedAt: null, escalatedAt: null },
        data: { escalatedAt: NOW },
      });
      expect(dispatcher.dispatchDirect).toHaveBeenCalledWith(
        tx,
        'approval.overdue',
        {
          label: 'Intake review',
          code: 'XPR-00042',
          title: 'Roof repair',
          link: '/requests/XPR-00042',
        },
        ['holder-1', 'admin-1', 'admin-1', 'admin-2'],
        'r1',
      );
    });

    it('sends one per item: losing the claim sends nothing', async () => {
      const { sweeper, dispatcher } = setupOverdue([0]);

      await sweeper.sweep(NOW);

      expect(dispatcher.dispatchDirect).not.toHaveBeenCalled();
    });

    it('lets a failed send roll back its claim and carries on with the next sweep', async () => {
      const { sweeper, dispatcher } = setupOverdue();
      dispatcher.dispatchDirect.mockRejectedValueOnce(new Error('boom'));

      await expect(sweeper.sweep(NOW)).resolves.toEqual({
        reminded: 0,
        escalated: 0,
      });
    });
  });
});

describe('formatWorkingDuration', () => {
  it.each([
    [30, '30 min'],
    [120, '2 h'],
    [90, '1 h 30 min'],
    [600, '1 working day'],
    [1200, '2 working days'],
    [900, '15 h'],
  ])('%i minutes reads %s', (minutes, text) => {
    expect(formatWorkingDuration(minutes)).toBe(text);
  });
});
