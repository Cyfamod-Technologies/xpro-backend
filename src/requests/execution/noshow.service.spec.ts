import type { ActorContext } from '../../platform/actor/actor.types';
import { NOSHOW_ENTITY } from '../../uploads/entity-types';
import { systemCommandKit } from '../system-command.testkit';
import { NoShowService } from './noshow.service';

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

const noShowRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ns1',
  scheduleId: 's1',
  providerId: 'provider-1',
  status: 'open',
  version: 3,
  ...overrides,
});

function setup(
  tx: Record<string, unknown>,
  snap: Record<string, unknown> = {},
) {
  const kit = systemCommandKit({
    tx,
    now: NOW,
    snap: {
      status: 'scheduled',
      currentSchedule: { status: 'confirmed' },
      latestNoShow: { status: 'open' },
      ...snap,
    } as never,
  });
  const uploads = { attach: jest.fn().mockResolvedValue([]) };
  const providers = { recordReliabilityEvent: jest.fn() };
  const service = new NoShowService(
    { resolve: jest.fn().mockResolvedValue(staffActor) } as never,
    kit.runner,
    uploads as never,
    providers as never,
  );
  return { service, uploads, providers, ...kit };
}

describe('NoShowService.record', () => {
  const tx = () => ({
    schedule: {
      findFirst: jest.fn().mockResolvedValue({ id: 's1', assignmentId: 'a1' }),
    },
    noShow: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'ns1' }),
    },
    assignment: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'a1', providerId: 'provider-1' }),
    },
  });

  it('attaches the upload ids as noshow evidence (D-34)', async () => {
    const db = tx();
    const { service, uploads } = setup(db);

    await service.record(
      'staff-1',
      'XPR-00042',
      {
        scheduleId: 's1',
        note: 'Nobody came to site.',
        evidenceIds: ['u1', 'u2'],
      },
      undefined,
      '/url',
    );

    expect(uploads.attach).toHaveBeenCalledWith(
      db,
      ['u1', 'u2'],
      'staff-1',
      'progress_evidence',
      NOSHOW_ENTITY,
      'ns1',
    );
  });

  it('keeps the no_show item open for the schedule (02 §6.11)', async () => {
    const { service, effects } = setup(tx());

    await service.record(
      'staff-1',
      'XPR-00042',
      { scheduleId: 's1', note: 'Nobody came to site.' },
      undefined,
      '/url',
    );

    expect(effects.approvalOpens).toEqual([{ kind: 'no_show', itemId: 's1' }]);
  });

  it('attaches nothing when no evidence is sent', async () => {
    const { service, uploads } = setup(tx());

    await service.record(
      'staff-1',
      'XPR-00042',
      { scheduleId: 's1', note: 'Nobody came to site.' },
      undefined,
      '/url',
    );

    expect(uploads.attach).toHaveBeenCalledWith(
      expect.anything(),
      [],
      'staff-1',
      'progress_evidence',
      NOSHOW_ENTITY,
      'ns1',
    );
  });
});

describe('NoShowService reliability events (D-21)', () => {
  const decideTx = (row = noShowRow()) => ({
    noShow: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn(),
    },
  });

  it('confirm records one no_show_confirmed event keyed by the no-show id', async () => {
    const db = decideTx();
    const { service, providers } = setup(db);

    await service.decide(
      'staff-1',
      'XPR-00042',
      'ns1',
      'confirm',
      { note: ' Confirmed on site. ', version: 3 },
      undefined,
      '/url',
    );

    expect(providers.recordReliabilityEvent).toHaveBeenCalledWith(db, {
      providerId: 'provider-1',
      kind: 'no_show_confirmed',
      sourceId: 'ns1',
      requestId: 'request-1',
      occurredAt: NOW,
      confirmedBy: 'staff-1',
      note: 'Confirmed on site.',
    });
  });

  it.each([
    ['confirm', 'confirmed'],
    ['dismiss', 'dismissed'],
  ] as const)(
    '%s closes the no_show item of the schedule',
    async (outcome, status) => {
      const { service, effects } = setup(decideTx());

      await service.decide(
        'staff-1',
        'XPR-00042',
        'ns1',
        outcome,
        { note: 'Decided on the evidence.', version: 3 },
        undefined,
        '/url',
      );

      expect(effects.approvalCloses).toEqual([
        { kind: 'no_show', itemId: 's1', reason: status },
      ]);
    },
  );

  it('opens the reliability review when the confirmation makes it two in 90 days, and not otherwise', async () => {
    const due = setup(decideTx());
    due.providers.recordReliabilityEvent.mockResolvedValue('review_due');
    const quiet = setup(decideTx());
    quiet.providers.recordReliabilityEvent.mockResolvedValue(null);
    const decide = (kit: typeof due) =>
      kit.service.decide(
        'staff-1',
        'XPR-00042',
        'ns1',
        'confirm',
        { note: 'Confirmed on site.', version: 3 },
        undefined,
        '/url',
      );

    await decide(due);
    await decide(quiet);

    expect(due.effects.approvalOpens).toEqual([
      { kind: 'provider_reliability', itemId: 'provider-1' },
    ]);
    expect(quiet.effects.approvalOpens).toEqual([]);
  });

  it('dismiss records nothing', async () => {
    const { service, providers } = setup(decideTx());

    await service.decide(
      'staff-1',
      'XPR-00042',
      'ns1',
      'dismiss',
      { note: 'Provider was on site.', version: 3 },
      undefined,
      '/url',
    );

    expect(providers.recordReliabilityEvent).not.toHaveBeenCalled();
  });

  it('correct records a no_show_voided event keyed `<id>:voided`', async () => {
    const db = decideTx(noShowRow({ status: 'confirmed' }));
    const { service, providers } = setup(db, {
      latestNoShow: { status: 'confirmed' },
    });

    await service.correct(
      'staff-1',
      'XPR-00042',
      'ns1',
      { note: 'Wrong provider.', version: 3 },
      undefined,
      '/url',
    );

    expect(providers.recordReliabilityEvent).toHaveBeenCalledWith(db, {
      providerId: 'provider-1',
      kind: 'no_show_voided',
      sourceId: 'ns1:voided',
      requestId: 'request-1',
      occurredAt: NOW,
      confirmedBy: 'staff-1',
      note: 'Wrong provider.',
    });
  });

  it('correct closes the reliability review when the count drops back', async () => {
    const { service, providers, effects } = setup(
      decideTx(noShowRow({ status: 'confirmed' })),
      { latestNoShow: { status: 'confirmed' } },
    );
    providers.recordReliabilityEvent.mockResolvedValue('cleared');

    await service.correct(
      'staff-1',
      'XPR-00042',
      'ns1',
      { note: 'Wrong provider.', version: 3 },
      undefined,
      '/url',
    );

    expect(effects.approvalCloses).toEqual([
      {
        kind: 'provider_reliability',
        itemId: 'provider-1',
        reason: 'no_show_corrected',
      },
    ]);
  });
});
