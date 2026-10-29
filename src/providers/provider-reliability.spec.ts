import { ProvidersService } from './providers.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');

function setup(options: {
  created?: number;
  events?: Array<{ kind: string; sourceId: string }>;
}) {
  const tx = {
    providerReliabilityEvent: {
      create: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: options.created ?? 1 }),
      findMany: jest.fn().mockResolvedValue(options.events ?? []),
    },
    providerProfile: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new ProvidersService(
    ...(Array.from({ length: 8 }, () => ({})) as [
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
    ]),
  );
  const record = (
    kind: 'no_show_confirmed' | 'no_show_voided' | 'declined' | 'expired',
    sourceId: string,
  ) =>
    service.recordReliabilityEvent(tx as never, {
      providerId: 'provider-1',
      kind,
      sourceId,
      occurredAt: NOW,
    });
  return { tx, record };
}

describe('ProvidersService.recordReliabilityEvent (B-32, D-21)', () => {
  it('inserts with createMany skipDuplicates, never create (no P2002 inside the transaction)', async () => {
    const { tx, record } = setup({});

    await record('no_show_confirmed', 'ns1');

    expect(tx.providerReliabilityEvent.create).not.toHaveBeenCalled();
    expect(tx.providerReliabilityEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ sourceId: 'ns1' }) as unknown],
      skipDuplicates: true,
    });
  });

  it('does nothing more for a duplicate source id', async () => {
    const { tx, record } = setup({ created: 0 });

    await record('no_show_confirmed', 'ns1');

    expect(tx.providerReliabilityEvent.findMany).not.toHaveBeenCalled();
    expect(tx.providerProfile.update).not.toHaveBeenCalled();
  });

  it('marks review_due at two confirmed no-shows in 90 days', async () => {
    const { tx, record } = setup({
      events: [
        { kind: 'no_show_confirmed', sourceId: 'ns1' },
        { kind: 'no_show_confirmed', sourceId: 'ns2' },
      ],
    });

    await expect(record('no_show_confirmed', 'ns2')).resolves.toBe(
      'review_due',
    );

    expect(tx.providerProfile.update).toHaveBeenCalledWith({
      where: { id: 'provider-1' },
      data: { reliabilityStatus: 'review_due' },
    });
  });

  it('does not count a confirmed no-show that was voided', async () => {
    const { tx, record } = setup({
      events: [
        { kind: 'no_show_confirmed', sourceId: 'ns1' },
        { kind: 'no_show_confirmed', sourceId: 'ns2' },
        { kind: 'no_show_voided', sourceId: 'ns2:voided' },
      ],
    });

    await record('no_show_confirmed', 'ns1');

    expect(tx.providerProfile.update).not.toHaveBeenCalled();
  });

  it('a void that drops the count below two returns review_due to normal', async () => {
    const { tx, record } = setup({
      events: [
        { kind: 'no_show_confirmed', sourceId: 'ns1' },
        { kind: 'no_show_confirmed', sourceId: 'ns2' },
        { kind: 'no_show_voided', sourceId: 'ns2:voided' },
      ],
    });

    await expect(record('no_show_voided', 'ns2:voided')).resolves.toBe(
      'cleared',
    );

    expect(tx.providerProfile.updateMany).toHaveBeenCalledWith({
      where: { id: 'provider-1', reliabilityStatus: 'review_due' },
      data: { reliabilityStatus: 'normal' },
    });
    expect(tx.providerProfile.update).not.toHaveBeenCalled();
  });

  it('a void leaves review_due alone while two no-shows still count', async () => {
    const { tx, record } = setup({
      events: [
        { kind: 'no_show_confirmed', sourceId: 'ns1' },
        { kind: 'no_show_confirmed', sourceId: 'ns2' },
        { kind: 'no_show_confirmed', sourceId: 'ns3' },
        { kind: 'no_show_voided', sourceId: 'ns3:voided' },
      ],
    });

    await record('no_show_voided', 'ns3:voided');

    expect(tx.providerProfile.updateMany).not.toHaveBeenCalled();
  });

  it('declined and expired events are stored without a recompute', async () => {
    const { tx, record } = setup({});

    await record('declined', 'a1');

    expect(tx.providerReliabilityEvent.createMany).toHaveBeenCalled();
    expect(tx.providerReliabilityEvent.findMany).not.toHaveBeenCalled();
  });
});
