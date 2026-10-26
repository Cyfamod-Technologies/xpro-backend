import { createHash, createHmac } from 'node:crypto';
import { TimerRegistry } from '../platform/timers/timer-registry';
import type { VerifiedTransaction } from './payment-gateway';
import type { InboundEvent } from './gateway-inbox.service';
import { PaystackEventsService } from './paystack-events.service';

const SECRET = 'sk_test_secret';
const payment = {
  id: 'payment-1',
  requestId: 'request-1',
  quoteId: 'quote-1',
  reference: 'xpro_1',
  amount: 500_000n,
  status: 'pending',
};
const verified = (
  overrides: Partial<VerifiedTransaction> = {},
): VerifiedTransaction => ({
  status: 'success',
  reference: 'xpro_1',
  amount: 500_000,
  currency: 'NGN',
  ...overrides,
});
const signed = (payload: unknown) => {
  const rawBody = Buffer.from(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  );
  return {
    rawBody,
    signature: createHmac('sha512', SECRET).update(rawBody).digest('hex'),
  };
};
const chargeEvent = { event: 'charge.success', data: { reference: 'xpro_1' } };

function build() {
  const prisma = {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    refund: { findFirst: jest.fn().mockResolvedValue(null) },
    transferAttempt: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const gateway = {
    verify: jest.fn().mockResolvedValue(verified()),
    verifyRefund: jest.fn(),
    verifyTransfer: jest.fn(),
  };
  const received: Array<InboundEvent & { rawBodyDigest: string }> = [];
  const inbox = {
    receive: jest.fn(
      (
        event: InboundEvent & { rawBodyDigest: string },
        process: (e: InboundEvent) => Promise<unknown>,
      ) => {
        received.push(event);
        return process(event);
      },
    ),
    markDone: jest.fn().mockResolvedValue(undefined),
    sweep: jest.fn().mockResolvedValue(0),
  };
  const payments = {
    matchOrQuarantine: jest.fn().mockResolvedValue({ matches: true }),
    settleCharge: jest.fn().mockResolvedValue({ claimed: true }),
    quarantine: jest.fn().mockResolvedValue(undefined),
  };
  const refunds = {
    settleFromGateway: jest.fn().mockResolvedValue({ applied: true }),
  };
  const finance = {
    settleTransferFromGateway: jest.fn().mockResolvedValue({ applied: true }),
  };
  const registry = new TimerRegistry();
  const service = new PaystackEventsService(
    prisma as never,
    { get: () => SECRET } as never,
    gateway as never,
    inbox as never,
    payments as never,
    refunds as never,
    finance as never,
    registry,
  );
  return {
    service,
    prisma,
    gateway,
    inbox,
    payments,
    refunds,
    finance,
    registry,
    received,
  };
}

describe('PaystackEventsService.handleWebhook', () => {
  it('rejects a bad signature before touching the inbox', async () => {
    const { service, inbox } = build();
    const { rawBody } = signed(chargeEvent);

    await expect(
      service.handleWebhook(rawBody, 'a'.repeat(128)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.handleWebhook(rawBody, undefined),
    ).rejects.toMatchObject({ status: 401 });
    expect(inbox.receive).not.toHaveBeenCalled();
  });

  it('takes every field from the verified raw bytes', async () => {
    const { service, received } = build();
    const { rawBody, signature } = signed({
      event: 'refund.processed',
      data: { reference: 'xpro_9', id: 77 },
    });

    await service.handleWebhook(rawBody, signature);

    expect(received[0]).toEqual({
      fingerprint: createHash('sha256').update(rawBody).digest('hex'),
      rawBodyDigest: createHash('sha256').update(rawBody).digest('hex'),
      event: 'refund.processed',
      reference: 'xpro_9',
      subjectId: '77',
    });
  });

  it('rejects a correctly signed body that is not JSON', async () => {
    const { service, inbox } = build();
    const { rawBody, signature } = signed('not json');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).rejects.toMatchObject({ status: 400 });
    expect(inbox.receive).not.toHaveBeenCalled();
  });

  it('settles a matching charge.success and closes the inbox row in the same transaction', async () => {
    const { service, payments, inbox } = build();
    const { rawBody, signature } = signed(chargeEvent);

    const result = await service.handleWebhook(rawBody, signature);

    expect(result).toMatchObject({ status: 'processed', duplicate: false });
    const [paymentArg, verifiedArg, options] = payments.settleCharge.mock
      .calls[0] as [
      unknown,
      unknown,
      { source: string; onSettled: (tx: unknown) => Promise<void> },
    ];
    expect(paymentArg).toBe(payment);
    expect(verifiedArg).toMatchObject({ reference: 'xpro_1' });
    expect(options.source).toBe('webhook');
    const tx = {};
    await options.onSettled(tx);
    expect(inbox.markDone).toHaveBeenCalledWith(tx, expect.any(String), {
      status: 'processed',
    });
  });

  it('acknowledges an out-of-order or repeated charge as a duplicate with no effect', async () => {
    const { service, payments } = build();
    payments.settleCharge.mockResolvedValue({ claimed: false });
    const { rawBody, signature } = signed(chargeEvent);

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'processed', duplicate: true });
  });

  it('quarantines a mismatched charge instead of settling or ignoring it', async () => {
    const { service, payments } = build();
    payments.matchOrQuarantine.mockResolvedValue({
      matches: false,
      reason: 'The transaction amount differs.',
    });
    const { rawBody, signature } = signed(chargeEvent);

    const result = await service.handleWebhook(rawBody, signature);

    expect(result).toMatchObject({
      status: 'quarantined',
      reason: 'The transaction amount differs.',
    });
    expect(payments.settleCharge).not.toHaveBeenCalled();
  });

  it('quarantines a verified charge whose reference no payment owns', async () => {
    const { service, prisma, payments, inbox } = build();
    prisma.payment.findUnique.mockResolvedValue(null);
    const { rawBody, signature } = signed(chargeEvent);

    const result = await service.handleWebhook(rawBody, signature);

    expect(result).toMatchObject({ status: 'quarantined' });
    expect(payments.quarantine).toHaveBeenCalledWith(
      {
        payment: null,
        reference: 'xpro_1',
        reason: 'No XPro payment has this reference.',
      },
      expect.any(Function),
    );
    const [, inTx] = payments.quarantine.mock.calls[0] as [
      unknown,
      (tx: unknown) => Promise<void>,
    ];
    await inTx({});
    expect(inbox.markDone).toHaveBeenCalledWith({}, expect.any(String), {
      status: 'quarantined',
      reason: 'No XPro payment has this reference.',
    });
  });

  it('ignores an unknown reference that Paystack does not report as successful', async () => {
    const { service, prisma, gateway, payments } = build();
    prisma.payment.findUnique.mockResolvedValue(null);
    gateway.verify.mockResolvedValue(verified({ status: 'failed' }));
    const { rawBody, signature } = signed(chargeEvent);

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(payments.quarantine).not.toHaveBeenCalled();
  });

  it('does not settle when the verified transaction is not successful', async () => {
    const { service, gateway, payments } = build();
    gateway.verify.mockResolvedValue(verified({ status: 'abandoned' }));
    const { rawBody, signature } = signed(chargeEvent);

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(payments.settleCharge).not.toHaveBeenCalled();
  });

  it('lets a verification failure bubble up so the inbox can retry the event', async () => {
    const { service, gateway } = build();
    gateway.verify.mockRejectedValue(new Error('Paystack timed out'));
    const { rawBody, signature } = signed(chargeEvent);

    await expect(service.handleWebhook(rawBody, signature)).rejects.toThrow(
      'Paystack timed out',
    );
  });

  it('ignores event types it does not handle', async () => {
    const { service } = build();
    const { rawBody, signature } = signed({
      event: 'customeridentification.success',
      data: {},
    });

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
  });

  it('ignores a refund event it cannot verify against an approved refund', async () => {
    const { service } = build();
    const { rawBody, signature } = signed({
      event: 'refund.processed',
      data: { id: 5 },
    });

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
  });
});

describe('PaystackEventsService refund events', () => {
  const refund = {
    id: 'refund-1',
    amount: 500_000n,
    status: 'processing',
    gatewayRefundId: '77',
  };
  const refundEvent = (event: string, data: Record<string, unknown> = {}) =>
    signed({ event, data: { id: 77, ...data } });
  const withRefund = () => {
    const harness = build();
    harness.prisma.refund.findFirst.mockResolvedValue(refund);
    return harness;
  };

  it('refund.processed: verifies with Paystack, then settles in one transaction with the inbox row', async () => {
    const { service, gateway, refunds, inbox } = withRefund();
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 500_000,
    });
    const { rawBody, signature } = refundEvent('refund.processed');

    const result = await service.handleWebhook(rawBody, signature);

    expect(result).toMatchObject({ status: 'processed', duplicate: false });
    expect(gateway.verifyRefund).toHaveBeenCalledWith('77');
    const [id, verified, options] = refunds.settleFromGateway.mock.calls[0] as [
      string,
      { id: string; status: string },
      { actor: null; onSettled: (tx: unknown) => Promise<void> },
    ];
    expect(id).toBe('refund-1');
    expect(verified).toMatchObject({ id: '77', status: 'processed' });
    expect(options.actor).toBeNull();
    const tx = {};
    await options.onSettled(tx);
    expect(inbox.markDone).toHaveBeenCalledWith(tx, expect.any(String), {
      status: 'processed',
    });
  });

  it('acknowledges a repeated refund.processed as a duplicate', async () => {
    const { service, gateway, refunds } = withRefund();
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 500_000,
    });
    refunds.settleFromGateway.mockResolvedValue({ applied: false });
    const { rawBody, signature } = refundEvent('refund.processed');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'processed', duplicate: true });
  });

  it.each([
    ['refund.failed', 'failed'],
    ['refund.needs-attention', 'needs-attention'],
  ])(
    '%s: verifies the failure and settles it as failed (C-11)',
    async (event, gatewayStatus) => {
      const { service, gateway, refunds } = withRefund();
      gateway.verifyRefund.mockResolvedValue({
        id: '77',
        status: gatewayStatus,
        amount: 500_000,
      });
      const { rawBody, signature } = refundEvent(event);

      await expect(
        service.handleWebhook(rawBody, signature),
      ).resolves.toMatchObject({ status: 'processed' });
      expect(refunds.settleFromGateway).toHaveBeenCalledWith(
        'refund-1',
        expect.objectContaining({ id: '77', status: gatewayStatus }),
        expect.objectContaining({ actor: null }),
      );
    },
  );

  it('ignores an event whose state Paystack does not confirm', async () => {
    const { service, gateway, refunds } = withRefund();
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 500_000,
    });
    const { rawBody, signature } = refundEvent('refund.failed');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(refunds.settleFromGateway).not.toHaveBeenCalled();
  });

  it('ignores a refund whose verified amount differs', async () => {
    const { service, gateway, refunds } = withRefund();
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 1,
    });
    const { rawBody, signature } = refundEvent('refund.processed');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(refunds.settleFromGateway).not.toHaveBeenCalled();
  });

  it('finds an in-flight refund whose gateway id was never recorded by the transaction reference', async () => {
    const { service, prisma, gateway, refunds } = build();
    prisma.refund.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...refund, gatewayRefundId: null });
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 500_000,
    });
    const { rawBody, signature } = refundEvent('refund.processed', {
      transaction_reference: 'xpro_1',
    });

    await service.handleWebhook(rawBody, signature);

    expect(prisma.refund.findFirst).toHaveBeenLastCalledWith({
      where: {
        status: 'processing',
        gatewayRefundId: null,
        payment: { reference: 'xpro_1' },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(refunds.settleFromGateway).toHaveBeenCalled();
  });

  it('does not touch the gateway for pending or processing refund events', async () => {
    const { service, gateway, refunds } = withRefund();
    for (const event of ['refund.pending', 'refund.processing']) {
      const { rawBody, signature } = refundEvent(event);
      await expect(
        service.handleWebhook(rawBody, signature),
      ).resolves.toMatchObject({ status: 'ignored' });
    }
    expect(gateway.verifyRefund).not.toHaveBeenCalled();
    expect(refunds.settleFromGateway).not.toHaveBeenCalled();
  });

  it('lets a settlement error bubble up so the inbox retries the event', async () => {
    const { service, gateway, refunds } = withRefund();
    gateway.verifyRefund.mockResolvedValue({
      id: '77',
      status: 'processed',
      amount: 500_000,
    });
    refunds.settleFromGateway.mockRejectedValue(new Error('deadlock'));
    const { rawBody, signature } = refundEvent('refund.processed');

    await expect(service.handleWebhook(rawBody, signature)).rejects.toThrow(
      'deadlock',
    );
  });
});

describe('PaystackEventsService transfer events (C-19)', () => {
  const transferEvent = (event: string) =>
    signed({ event, data: { reference: 'xpro_tr_abc' } });
  const withAttempt = () => {
    const harness = build();
    harness.prisma.transferAttempt.findUnique.mockResolvedValue({
      id: 'attempt-1',
    });
    return harness;
  };

  it('verifies the transfer and settles it through the finance service, closing the inbox row in the same transaction', async () => {
    const { service, gateway, finance, inbox } = withAttempt();
    gateway.verifyTransfer.mockResolvedValue({
      reference: 'xpro_tr_abc',
      status: 'success',
      amount: 9_000_000,
    });
    const { rawBody, signature } = transferEvent('transfer.success');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'processed' });

    expect(gateway.verifyTransfer).toHaveBeenCalledWith('xpro_tr_abc');
    expect(finance.settleTransferFromGateway).toHaveBeenCalledWith(
      'xpro_tr_abc',
      'success',
      expect.objectContaining({ actor: null, verifiedAmount: 9_000_000 }),
    );
    const options = (
      finance.settleTransferFromGateway.mock.calls as unknown as Array<
        [string, string, { onSettled: (tx: unknown) => Promise<void> }]
      >
    )[0][2];
    const tx = {};
    await options.onSettled(tx);
    expect(inbox.markDone).toHaveBeenCalledWith(tx, expect.any(String), {
      status: 'processed',
    });
  });

  it.each([
    ['transfer.failed', 'failed'],
    ['transfer.reversed', 'reversed'],
  ])('settles %s as %s', async (event, outcome) => {
    const { service, gateway, finance } = withAttempt();
    gateway.verifyTransfer.mockResolvedValue({
      reference: 'xpro_tr_abc',
      status: outcome,
    });
    const { rawBody, signature } = transferEvent(event);

    await service.handleWebhook(rawBody, signature);

    expect(finance.settleTransferFromGateway).toHaveBeenCalledWith(
      'xpro_tr_abc',
      outcome,
      expect.anything(),
    );
  });

  it('ignores an event that Paystack does not confirm, or for an unknown reference', async () => {
    const { service, gateway, finance, prisma } = withAttempt();
    gateway.verifyTransfer.mockResolvedValue({
      reference: 'xpro_tr_abc',
      status: 'pending',
    });
    const { rawBody, signature } = transferEvent('transfer.success');
    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });

    gateway.verifyTransfer.mockResolvedValue(null);
    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });

    prisma.transferAttempt.findUnique.mockResolvedValue(null);
    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(finance.settleTransferFromGateway).not.toHaveBeenCalled();
  });

  it('reports a duplicate when the settlement changed nothing', async () => {
    const { service, gateway, finance } = withAttempt();
    gateway.verifyTransfer.mockResolvedValue({
      reference: 'xpro_tr_abc',
      status: 'success',
    });
    finance.settleTransferFromGateway.mockResolvedValue({ applied: false });
    const { rawBody, signature } = transferEvent('transfer.success');

    await expect(
      service.handleWebhook(rawBody, signature),
    ).resolves.toMatchObject({ status: 'processed', duplicate: true });
  });
});

describe('PaystackEventsService sweeper', () => {
  it('registers a sweeper on the timers sweep that retries stored events', async () => {
    const { service, registry, inbox } = build();
    service.onModuleInit();
    const now = new Date('2026-10-25T10:00:00.000Z');

    expect(registry.sweepHandlers()).toHaveLength(1);
    await registry.sweepHandlers()[0](now);

    expect(inbox.sweep).toHaveBeenCalledWith(expect.any(Function), now);
  });
});
