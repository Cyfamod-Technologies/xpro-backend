import { ActorContext } from '../actor/actor.types';
import { AppError } from '../errors/app-error';
import { SettingsService } from './settings.service';

const staffActor: ActorContext = {
  userId: 'staff-1',
  kind: 'staff',
  displayName: 'Rae Staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    roles: ['super_admin'],
    permissions: new Set(['settings.manage']),
    canOwn: true,
    isSuperAdmin: true,
    permVersion: 1,
  },
};

function serviceHarness(setting: unknown = null) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    setting: {
      findUnique: jest.fn().mockResolvedValue(setting),
      upsert: jest
        .fn()
        .mockImplementation(({ create, update }) =>
          Promise.resolve({ ...create, ...update }),
        ),
    },
    settingHistory: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    staffMember: { findMany: jest.fn().mockResolvedValue([]) },
    inAppNotification: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    setting: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest
      .fn()
      .mockImplementation((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: typeof tx) => unknown)(tx)
          : Promise.all(arg as unknown[]),
      ),
  };
  const audit = { record: jest.fn() };
  const inbox = { createMany: jest.fn() };
  const context = { getIp: jest.fn().mockReturnValue('127.0.0.1') };
  const sessions = { consumeReauthToken: jest.fn().mockResolvedValue(true) };
  const subject = new SettingsService(
    prisma as never,
    audit as never,
    inbox as never,
    context as never,
    sessions as never,
  );
  return { subject, tx, prisma, audit, inbox, sessions };
}

describe('SettingsService', () => {
  it('returns all registered defaults when no settings rows exist', async () => {
    const { subject, prisma } = serviceHarness();
    const snapshot = await subject.snapshot();
    expect(snapshot.length).toBeGreaterThan(20);
    expect(
      snapshot.find((row) => row.key === 'assignment.weights')?.value,
    ).toEqual({
      area: 25,
      capacity: 20,
      fairness: 15,
      experience: 5,
      reliability: 0,
    });
    expect(snapshot.every((row) => row.version === 1)).toBe(true);
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('rejects stale per-key versions with the specified conflict', async () => {
    const { subject, tx } = serviceHarness({
      key: 'payment.dueDays',
      value: 7,
      version: 2,
      riskClass: 'operational',
      updatedBy: 'staff-1',
      updatedAt: new Date(),
    });

    await expect(
      subject.save(
        staffActor,
        [{ key: 'payment.dueDays', value: 8, expectedVersion: 1 }],
        'Change due period',
      ),
    ).rejects.toMatchObject<Partial<AppError>>({
      code: 'VERSION_CONFLICT',
      message:
        'These settings changed since you opened them. Reload and try again.',
    });
    expect(tx.setting.upsert).not.toHaveBeenCalled();
    expect(tx.settingHistory.createMany).not.toHaveBeenCalled();
  });

  it('writes history rows with actor, reason and one shared change set', async () => {
    const { subject, tx, audit } = serviceHarness();
    const saved = await subject.save(
      staffActor,
      [
        { key: 'payment.dueDays', value: 8, expectedVersion: 1 },
        { key: 'assignment.offerExpiryHours', value: 36, expectedVersion: 1 },
      ],
      'Adjust operational timings',
    );

    expect(tx.settingHistory.createMany).toHaveBeenCalledTimes(1);
    const [history] = tx.settingHistory.createMany.mock.calls[0] as [
      { data: Array<Record<string, unknown>> },
    ];
    expect(history.data).toHaveLength(2);
    expect(history.data.map((row) => row.key)).toEqual([
      'payment.dueDays',
      'assignment.offerExpiryHours',
    ]);
    expect(new Set(history.data.map((row) => row.changeSetId)).size).toBe(1);
    expect(history.data[0]).toMatchObject({
      actorId: 'staff-1',
      actorName: 'Rae Staff',
      reason: 'Adjust operational timings',
      oldValue: 7,
      newValue: 8,
      sessionId: undefined,
      ip: '127.0.0.1',
    });
    expect(saved.changes[0].version).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.changed',
        entityType: 'settings',
      }),
    );
  });
});
