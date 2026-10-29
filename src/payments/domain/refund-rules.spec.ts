import {
  REFUND_MESSAGES,
  RESUBMIT_COOLDOWN_MS,
  cancellationRefundsResolved,
  checkDecider,
  checkReconciler,
  checkSecondApprover,
  classifyGatewayRefund,
  planDecision,
  planRefundRequest,
  planSecondApproval,
  refundRegime,
  refundableBalance,
  withinResubmitCooldown,
} from './refund-rules';

const decision = (
  overrides: Partial<Parameters<typeof planDecision>[0]> = {},
): Parameters<typeof planDecision>[0] => ({
  regime: 'before_work',
  approve: true,
  reason: 'Customer cancelled before the visit.',
  requestedAmount: undefined,
  currentAmount: 500_000n,
  balance: 500_000n,
  ...overrides,
});

describe('refundableBalance', () => {
  it('is the amount paid when nothing else holds it', () => {
    expect(refundableBalance(500_000n, [])).toBe(500_000n);
  });

  it('subtracts every refund that holds money, whatever its progress', () => {
    expect(
      refundableBalance(500_000n, [
        { amount: 100_000n, status: 'completed' },
        { amount: 50_000n, status: 'processing' },
        { amount: 25_000n, status: 'pending_approval' },
        { amount: 25_000n, status: 'awaiting_second_approval' },
        { amount: 10_000n, status: 'approved' },
        { amount: 0n, status: 'waived' },
      ]),
    ).toBe(290_000n);
  });

  it('ignores rejected and failed refunds', () => {
    expect(
      refundableBalance(500_000n, [
        { amount: 500_000n, status: 'rejected' },
        { amount: 500_000n, status: 'failed' },
      ]),
    ).toBe(500_000n);
  });

  it('never goes below zero', () => {
    expect(
      refundableBalance(100n, [{ amount: 500n, status: 'completed' }]),
    ).toBe(0n);
  });
});

describe('refundRegime', () => {
  it('follows the cancellation, and a refund without one is standalone', () => {
    expect(refundRegime(null)).toBe('standalone');
    expect(refundRegime({ workStarted: false })).toBe('before_work');
    expect(refundRegime({ workStarted: true })).toBe('after_work');
  });
});

describe('planDecision before work started (C-08)', () => {
  it('approves exactly the full refundable balance when no amount is sent', () => {
    expect(planDecision(decision())).toEqual({
      ok: true,
      status: 'approved',
      amount: 500_000n,
    });
  });

  it('uses the current balance, not the amount the row was opened with', () => {
    expect(
      planDecision(decision({ currentAmount: 500_000n, balance: 400_000n })),
    ).toEqual({ ok: true, status: 'approved', amount: 400_000n });
  });

  it('accepts an amount that is the full balance', () => {
    expect(planDecision(decision({ requestedAmount: 500_000n }))).toMatchObject(
      { ok: true, amount: 500_000n },
    );
  });

  it('refuses any smaller amount, including zero', () => {
    for (const requestedAmount of [499_999n, 1n, 0n])
      expect(planDecision(decision({ requestedAmount }))).toEqual({
        ok: false,
        status: 422,
        code: 'VALIDATION_ERROR',
        message: REFUND_MESSAGES.fullBalance,
      });
  });

  it('refuses an amount above the balance with the 05 message', () => {
    expect(planDecision(decision({ requestedAmount: 500_001n }))).toMatchObject(
      { ok: false, message: 'This refund exceeds the amount available.' },
    );
  });

  it('refuses when nothing is left to refund', () => {
    expect(planDecision(decision({ balance: 0n }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.nothingLeft,
    });
  });

  it('needs a reason', () => {
    expect(planDecision(decision({ reason: '   ' }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.addReason,
    });
  });
});

describe('planDecision after work started (C-07)', () => {
  const after = (overrides: Partial<Parameters<typeof planDecision>[0]> = {}) =>
    decision({ regime: 'after_work', ...overrides });

  it('sends every approval to the second approval, a zero amount included', () => {
    expect(planDecision(after({ requestedAmount: 0n }))).toEqual({
      ok: true,
      status: 'awaiting_second_approval',
      amount: 0n,
    });
    expect(planDecision(after({ requestedAmount: 120_000n }))).toEqual({
      ok: true,
      status: 'awaiting_second_approval',
      amount: 120_000n,
    });
    expect(planDecision(after({ requestedAmount: 500_000n }))).toMatchObject({
      status: 'awaiting_second_approval',
    });
  });

  it('needs the amount to be stated', () => {
    expect(planDecision(after())).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.enterAmount,
    });
  });

  it('refuses an amount above the balance', () => {
    expect(planDecision(after({ requestedAmount: 500_001n }))).toMatchObject({
      ok: false,
      message: 'This refund exceeds the amount available.',
    });
  });

  it('asks for the explanation with the 05 message when the reason is blank', () => {
    expect(
      planDecision(after({ requestedAmount: 100n, reason: '' })),
    ).toMatchObject({
      ok: false,
      status: 422,
      message: 'Explain the refund amount after work has started.',
    });
  });
});

describe('planDecision for a refund without a cancellation', () => {
  const standalone = (
    overrides: Partial<Parameters<typeof planDecision>[0]> = {},
  ) => decision({ regime: 'standalone', ...overrides });

  it('approves the requested amount with one decider', () => {
    expect(planDecision(standalone())).toEqual({
      ok: true,
      status: 'approved',
      amount: 500_000n,
    });
    expect(planDecision(standalone({ requestedAmount: 100n }))).toMatchObject({
      status: 'approved',
      amount: 100n,
    });
  });

  it('never approves zero, and never more than the balance', () => {
    expect(planDecision(standalone({ requestedAmount: 0n }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.zeroBeforeWork,
    });
    expect(
      planDecision(standalone({ requestedAmount: 500_001n })),
    ).toMatchObject({ ok: false, message: REFUND_MESSAGES.exceeds });
  });
});

describe('planDecision rejecting', () => {
  it('needs only a reason and keeps the amount', () => {
    for (const regime of ['before_work', 'after_work', 'standalone'] as const)
      expect(
        planDecision(decision({ regime, approve: false, balance: 0n })),
      ).toEqual({ ok: true, status: 'rejected', amount: 500_000n });
    expect(
      planDecision(decision({ approve: false, reason: ' ' })),
    ).toMatchObject({ ok: false, message: REFUND_MESSAGES.addReason });
  });
});

describe('planSecondApproval', () => {
  const second = (
    overrides: Partial<Parameters<typeof planSecondApproval>[0]> = {},
  ) => ({
    approve: true,
    reason: 'Half the job was done.',
    amount: 120_000n,
    balance: 500_000n,
    ...overrides,
  });

  it('approves a positive amount', () => {
    expect(planSecondApproval(second())).toEqual({
      ok: true,
      status: 'approved',
    });
  });

  it('waives a zero amount (C-07)', () => {
    expect(planSecondApproval(second({ amount: 0n }))).toEqual({
      ok: true,
      status: 'waived',
    });
  });

  it('rejects', () => {
    expect(planSecondApproval(second({ approve: false }))).toEqual({
      ok: true,
      status: 'rejected',
    });
  });

  it('refuses when other refunds have since taken the balance', () => {
    expect(planSecondApproval(second({ balance: 119_999n }))).toMatchObject({
      ok: false,
      message: 'This refund exceeds the amount available.',
    });
  });

  it('needs a reason, with the 05 wording for an approval', () => {
    expect(planSecondApproval(second({ reason: '' }))).toMatchObject({
      ok: false,
      message: 'Explain the refund amount after work has started.',
    });
    expect(
      planSecondApproval(second({ reason: '', approve: false })),
    ).toMatchObject({ ok: false, message: REFUND_MESSAGES.addReason });
  });
});

describe('two-person rules (02 §6.14, 05 §5, §6.4)', () => {
  it('the requester cannot decide their own refund', () => {
    expect(checkDecider('finance-1', 'finance-1')).toEqual({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Another staff member must decide this refund.',
    });
    expect(checkDecider('finance-1', 'finance-2')).toBeNull();
    expect(checkDecider('system', 'finance-2')).toBeNull();
  });

  it('the second approver is a Super admin other than the first decider', () => {
    expect(
      checkSecondApprover({
        decidedBy: 'finance-2',
        userId: 'admin-1',
        isSuperAdmin: true,
      }),
    ).toBeNull();
    expect(
      checkSecondApprover({
        decidedBy: 'admin-1',
        userId: 'admin-1',
        isSuperAdmin: true,
      }),
    ).toMatchObject({
      status: 403,
      message: 'Another staff member must decide this refund.',
    });
    expect(
      checkSecondApprover({
        decidedBy: 'finance-2',
        userId: 'finance-3',
        isSuperAdmin: false,
      }),
    ).toMatchObject({ status: 403 });
  });

  it('the reconciler is neither the transfer recorder nor the requester (C-22)', () => {
    const base = {
      requestedBy: 'finance-1',
      transferRecordedBy: 'finance-2',
    };
    expect(checkReconciler({ ...base, userId: 'finance-3' })).toBeNull();
    expect(checkReconciler({ ...base, userId: 'finance-2' })).toMatchObject({
      status: 403,
    });
    expect(checkReconciler({ ...base, userId: 'finance-1' })).toMatchObject({
      status: 403,
    });
  });
});

describe('planRefundRequest (refund.request)', () => {
  const request = (
    overrides: Partial<Parameters<typeof planRefundRequest>[0]> = {},
  ): Parameters<typeof planRefundRequest>[0] => ({
    regime: 'standalone',
    reason: 'Replace the rejected refund.',
    requestedAmount: undefined,
    balance: 500_000n,
    ...overrides,
  });

  it('defaults to the whole balance', () => {
    expect(planRefundRequest(request())).toEqual({
      ok: true,
      amount: 500_000n,
    });
  });

  it('before work for a cancellation is always the full balance', () => {
    expect(planRefundRequest(request({ regime: 'before_work' }))).toEqual({
      ok: true,
      amount: 500_000n,
    });
    expect(
      planRefundRequest(
        request({ regime: 'before_work', requestedAmount: 1n }),
      ),
    ).toMatchObject({ ok: false, message: REFUND_MESSAGES.fullBalance });
  });

  it('after work allows zero up to the balance', () => {
    expect(
      planRefundRequest(request({ regime: 'after_work', requestedAmount: 0n })),
    ).toEqual({ ok: true, amount: 0n });
  });

  it('a standalone refund cannot be zero', () => {
    expect(planRefundRequest(request({ requestedAmount: 0n }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.zeroBeforeWork,
    });
  });

  it('is capped to the balance and needs a balance and a reason', () => {
    expect(
      planRefundRequest(request({ requestedAmount: 500_001n })),
    ).toMatchObject({ ok: false, message: REFUND_MESSAGES.exceeds });
    expect(planRefundRequest(request({ balance: 0n }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.nothingLeft,
    });
    expect(planRefundRequest(request({ reason: ' ' }))).toMatchObject({
      ok: false,
      message: REFUND_MESSAGES.addReason,
    });
  });
});

describe('classifyGatewayRefund', () => {
  it('maps the Paystack refund statuses', () => {
    expect(classifyGatewayRefund('processed')).toBe('processed');
    expect(classifyGatewayRefund('Processed')).toBe('processed');
    expect(classifyGatewayRefund('failed')).toBe('failed');
    expect(classifyGatewayRefund('needs-attention')).toBe('failed');
    expect(classifyGatewayRefund('pending')).toBe('in_flight');
    expect(classifyGatewayRefund('processing')).toBe('in_flight');
  });

  it('never treats an unknown status as a reason to resubmit', () => {
    expect(classifyGatewayRefund('something-new')).toBe('in_flight');
  });
});

describe('resubmit cooldown', () => {
  const now = new Date('2026-10-25T10:00:00Z');

  it('holds a retry back while the last submission may still be completing', () => {
    expect(withinResubmitCooldown(new Date(now.getTime() - 1_000), now)).toBe(
      true,
    );
    expect(
      withinResubmitCooldown(
        new Date(now.getTime() - RESUBMIT_COOLDOWN_MS),
        now,
      ),
    ).toBe(false);
  });
});

describe('cancellationRefundsResolved (04 §5.2 #37)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 10, minute));
  const refund = (paymentId: string, status: string, minute = 0) => ({
    paymentId,
    status,
    createdAt: at(minute),
  });

  it('is not resolved without refunds', () => {
    expect(cancellationRefundsResolved([])).toBe(false);
  });

  it('is resolved when every refund is completed or waived', () => {
    expect(
      cancellationRefundsResolved([
        refund('p1', 'completed'),
        refund('p2', 'waived'),
      ]),
    ).toBe(true);
  });

  it('is not resolved while any refund is open', () => {
    for (const status of [
      'pending_approval',
      'awaiting_second_approval',
      'approved',
      'processing',
    ])
      expect(
        cancellationRefundsResolved([
          refund('p1', 'completed'),
          refund('p2', status),
        ]),
      ).toBe(false);
  });

  it('is not resolved while a rejected or failed refund has no replacement', () => {
    expect(cancellationRefundsResolved([refund('p1', 'rejected')])).toBe(false);
    expect(cancellationRefundsResolved([refund('p1', 'failed')])).toBe(false);
  });

  it('ignores a rejected or failed refund once a later one completed', () => {
    expect(
      cancellationRefundsResolved([
        refund('p1', 'rejected', 0),
        refund('p1', 'failed', 1),
        refund('p1', 'completed', 2),
      ]),
    ).toBe(true);
  });

  it('is not resolved when the replacement itself failed', () => {
    expect(
      cancellationRefundsResolved([
        refund('p1', 'completed', 0),
        refund('p1', 'failed', 1),
      ]),
    ).toBe(false);
  });
});
