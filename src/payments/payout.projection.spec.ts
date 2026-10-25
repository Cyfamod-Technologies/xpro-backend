import type { Payout, Refund } from '@prisma/client';
import {
  maskedBankAccount,
  safeHoldReason,
  toEarningsItem,
  toPayoutQueueItem,
  toRefundQueueItem,
} from './payout.projection';

const payout = (overrides: Partial<Payout> = {}): Payout =>
  ({
    id: 'payout-1',
    requestId: 'request-1',
    assignmentId: 'assignment-1',
    providerId: 'provider-1',
    kind: 'primary',
    amount: 9_000_000n,
    status: 'approved',
    holdReason: null,
    holdSource: null,
    approvalDueAt: new Date('2026-10-28T10:00:00.000Z'),
    bankAccountId: 'bank-row-secret',
    bankLast4: '1234',
    transferReference: 'xpro_tr_abc',
    transferProofId: 'proof-secret',
    transferRecordedBy: null,
    reconciledBy: 'staff-secret',
    paidAt: null,
    createdAt: new Date('2026-10-26T10:00:00.000Z'),
    updatedAt: new Date('2026-10-26T11:00:00.000Z'),
    ...overrides,
  }) as Payout;

const refund = (overrides: Partial<Refund> = {}): Refund =>
  ({
    id: 'refund-1',
    paymentId: 'payment-1',
    requestId: 'request-1',
    cancellationId: 'cancellation-1',
    amount: 500_000n,
    status: 'pending_approval',
    reason: 'Customer cancelled.',
    requestedBy: 'finance-secret',
    decidedBy: 'decider-secret',
    secondApprover: null,
    transferReference: 'ref-secret',
    transferProofId: 'proof-secret',
    transferRecordedBy: null,
    gatewayRefundId: 'gw-secret',
    reconciledBy: null,
    completedAt: null,
    createdAt: new Date('2026-10-26T10:00:00.000Z'),
    updatedAt: new Date('2026-10-26T11:00:00.000Z'),
    ...overrides,
  }) as Refund;

describe('payout queue DTO (C-42, E-27)', () => {
  it('is an allow-list: no proof, bank row, actor or timestamp internals', () => {
    const item = toPayoutQueueItem(payout(), 'Ada Plumbing', true);

    expect(Object.keys(item).sort()).toEqual(
      [
        'amount',
        'approvalDueAt',
        'assignmentId',
        'createdAt',
        'holdReason',
        'holdSource',
        'id',
        'kind',
        'maskedBankAccount',
        'method',
        'paidAt',
        'providerId',
        'providerName',
        'requestId',
        'status',
        'transferReference',
        'urgentReview',
      ].sort(),
    );
    const text = JSON.stringify(item);
    for (const secret of [
      'proof-secret',
      'bank-row-secret',
      'staff-secret',
      'transferProofId',
      'reconciledBy',
      'bankAccountId',
    ])
      expect(text).not.toContain(secret);
  });

  it('shows the amount in kobo and a masked destination with view.pricing', () => {
    expect(toPayoutQueueItem(payout(), null, true)).toMatchObject({
      amount: 9_000_000,
      maskedBankAccount: '•••• 1234',
      transferReference: 'xpro_tr_abc',
      method: 'paystack',
    });
  });

  it('masks the amount and the gateway reference without view.pricing', () => {
    const item = toPayoutQueueItem(payout(), null, false);

    expect(item.amount).toBeNull();
    expect(item.transferReference).toBeNull();
    expect(item.status).toBe('approved');
  });

  it('flags a processing transfer that was held for urgent review', () => {
    expect(
      toPayoutQueueItem(
        payout({
          status: 'processing',
          holdReason: 'Wrong account suspected.',
        }),
        null,
        true,
      ).urgentReview,
    ).toBe(true);
    expect(
      toPayoutQueueItem(payout({ status: 'processing' }), null, true)
        .urgentReview,
    ).toBe(false);
  });

  it('reports an offline transfer as offline', () => {
    expect(
      toPayoutQueueItem(payout({ transferRecordedBy: 'staff-1' }), null, true)
        .method,
    ).toBe('offline');
  });
});

describe('refund queue DTO (C-42, E-27)', () => {
  it('is an allow-list that leaves out actor ids, proofs and gateway ids', () => {
    const item = toRefundQueueItem(refund(), 'paystack', true);
    const text = JSON.stringify(item);

    expect(item).toMatchObject({
      id: 'refund-1',
      amount: 500_000,
      method: 'paystack',
      status: 'pending_approval',
    });
    for (const secret of [
      'finance-secret',
      'decider-secret',
      'ref-secret',
      'proof-secret',
      'gw-secret',
    ])
      expect(text).not.toContain(secret);
  });

  it('masks the amount without view.pricing', () => {
    expect(toRefundQueueItem(refund(), 'offline', false).amount).toBeNull();
  });
});

describe('provider earnings DTO (C-41)', () => {
  it('shows the amount, a masked destination and no staff reason', () => {
    const item = toEarningsItem(
      payout({
        status: 'on_hold',
        holdReason: 'Fraud ring suspected, see ticket 55.',
        holdSource: 'issue',
      }),
    );

    expect(item).toMatchObject({
      amount: 9_000_000,
      maskedBankAccount: '•••• 1234',
      holdReason: 'On hold while a reported issue is reviewed.',
    });
    expect(JSON.stringify(item)).not.toContain('Fraud ring');
    expect(JSON.stringify(item)).not.toContain('proof-secret');
  });

  it('falls back to the current verified bank before approval', () => {
    expect(
      toEarningsItem(
        payout({ bankLast4: null, status: 'pending_approval' }),
        '9876',
      ).maskedBankAccount,
    ).toBe('•••• 9876');
  });
});

describe('safeHoldReason and maskedBankAccount', () => {
  it('gives a safe reason per hold source, and none when not on hold', () => {
    expect(safeHoldReason('approved', 'issue')).toBeNull();
    expect(safeHoldReason('on_hold', 'suspension')).toMatch(/account/);
    expect(safeHoldReason('on_hold', 'bank_change')).toMatch(/bank details/);
    expect(safeHoldReason('on_hold', 'manual')).toMatch(/Finance/);
    expect(safeHoldReason('on_hold', 'replacement')).toBeNull();
    expect(safeHoldReason('on_hold', null)).toMatch(/Finance/);
  });

  it('masks to the last four digits only', () => {
    expect(maskedBankAccount('0042')).toBe('•••• 0042');
    expect(maskedBankAccount(null)).toBeNull();
  });
});
