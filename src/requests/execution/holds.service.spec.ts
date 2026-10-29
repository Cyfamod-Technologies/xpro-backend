import type { ActorContext } from '../../platform/actor/actor.types';
import { systemCommandKit } from '../system-command.testkit';
import { HoldsService } from './holds.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const staffActor = {
  userId: 'staff-1',
  kind: 'staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    permissions: new Set(['dispatch.manage']),
    canOwn: true,
    isSuperAdmin: false,
  },
} as unknown as ActorContext;

function setup(tx: Record<string, unknown>, snap: Record<string, unknown>) {
  const kit = systemCommandKit({ tx, now: NOW, snap });
  const service = new HoldsService(
    { resolve: jest.fn().mockResolvedValue(staffActor) } as never,
    kit.runner,
  );
  return { service, ...kit };
}

const heldSnap = (previousStatus: string, overrides = {}) => ({
  status: 'blocked',
  hold: { kind: 'staff', previousStatus },
  ...overrides,
});

describe('HoldsService timers (D-35)', () => {
  it('hold stops both T15 timers and T13, and starts T16', async () => {
    const tx = { serviceRequest: { update: jest.fn() } };
    const { service, effects } = setup(tx, { status: 'in_progress' });

    await service.hold(
      'staff-1',
      'XPR-00042',
      { reason: 'Site is flooded.', kind: 'staff' },
      undefined,
      '/url',
    );

    expect(effects.timerStops[0].kind).toEqual([
      'T13.noShowCheck',
      'T15.stale',
      'T15.escalate',
    ]);
    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual(['T16.review']);
  });

  it('releasing a hold on work in progress restarts both T15 timers', async () => {
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          holdPreviousStatus: 'in_progress',
          holdKind: 'staff',
        }),
        update: jest.fn(),
      },
    };
    const { service, effects } = setup(tx, heldSnap('in_progress'));

    await service.releaseHold(
      { id: 'staff-1' } as never,
      'XPR-00042',
      { note: 'Water cleared.' },
      undefined,
      '/url',
    );

    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T15.stale',
      'T15.escalate',
    ]);
    expect(effects.timerStops).toContainEqual({
      kind: 'T16.review',
      refId: undefined,
    });
  });

  it('releasing a hold from before work restarts T13 from the schedule', async () => {
    const startAt = new Date('2026-10-27T09:00:00.000Z');
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          holdPreviousStatus: 'scheduled',
          holdKind: 'staff',
        }),
        update: jest.fn(),
      },
      schedule: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1', startAt }),
      },
    };
    const { service, effects } = setup(
      tx,
      heldSnap('scheduled', {
        currentSchedule: {
          status: 'confirmed',
          startAt,
          endAt: new Date(startAt.getTime() + 3_600_000),
        },
      }),
    );

    await service.releaseHold(
      { id: 'staff-1' } as never,
      'XPR-00042',
      { note: 'Cleared.' },
      undefined,
      '/url',
    );

    expect(effects.timerStarts.map(({ kind }) => kind)).toEqual([
      'T13.noShowCheck',
    ]);
  });

  it('refuses the release once the confirmed date has passed, from the guard', async () => {
    const endAt = new Date(NOW.getTime() - 60_000);
    const tx = { serviceRequest: { findUnique: jest.fn() } };
    const { service } = setup(
      tx,
      heldSnap('scheduled', {
        currentSchedule: {
          status: 'confirmed',
          startAt: new Date(endAt.getTime() - 3_600_000),
          endAt,
        },
      }),
    );

    await expect(
      service.releaseHold(
        { id: 'staff-1' } as never,
        'XPR-00042',
        { note: 'Cleared.' },
        undefined,
        '/url',
      ),
    ).rejects.toMatchObject({
      message:
        'The confirmed date has passed. Propose a new date before releasing the hold.',
    });
    expect(tx.serviceRequest.findUnique).not.toHaveBeenCalled();
  });
});
