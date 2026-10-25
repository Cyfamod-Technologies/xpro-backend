import {
  BANK_CHANGE_SEPARATION_MS,
  PAYOUT_MESSAGES,
  TRANSFER_REFERENCE_PATTERN,
  TRANSFER_RETRY_COOLDOWN_MS,
  bankVersionOf,
  checkPayoutApproval,
  checkRelease,
  checkSecondApprover,
  classifyGatewayTransfer,
  closureStateOf,
  currentApprovals,
  decideTransferRetry,
  holdAction,
  needsSecondApproval,
  newTransferReference,
  parseStatusFilter,
  planPrimaryPayout,
  planSecondApproval,
  planTransferEvent,
} from './payout-rules';

const NOW = new Date('2026-10-26T10:00:00.000Z'); // a Monday, 11:00 WAT
const DAY = 24 * 60 * 60 * 1000;

const activeProvider = {
  userStatus: 'active',
  verification: 'verified',
  reliabilityStatus: 'normal',
};

const approval = (
  overrides: Partial<Parameters<typeof checkPayoutApproval>[0]> = {},
): Parameters<typeof checkPayoutApproval>[0] => ({
  approverId: 'finance-1',
  now: NOW,
  requestStatus: 'acknowledged',
  requestHold: null,
  issueStatuses: [],
  collectionSettled: true,
  provider: activeProvider,
  bank: {
    state: 'verified',
    reviewedBy: 'bank-reviewer',
    reviewedAt: new Date(NOW.getTime() - 30 * DAY),
  },
  pendingBankChange: false,
  ...overrides,
});

describe('checkPayoutApproval (05 §6.5)', () => {
  it('passes when every recheck holds', () => {
    expect(checkPayoutApproval(approval())).toBeNull();
  });

  it('also approves on a closed request', () => {
    expect(
      checkPayoutApproval(approval({ requestStatus: 'closed' })),
    ).toBeNull();
  });

  it.each(['completion_pending', 'in_progress', 'cancelling', 'cancelled'])(
    'refuses a request that is %s',
    (requestStatus) => {
      expect(checkPayoutApproval(approval({ requestStatus }))).toMatchObject({
        status: 409,
        message: PAYOUT_MESSAGES.requestNotAcknowledged,
      });
    },
  );

  it('refuses an unsettled collection', () => {
    expect(
      checkPayoutApproval(approval({ collectionSettled: false })),
    ).toMatchObject({
      status: 409,
      message: PAYOUT_MESSAGES.collectionNotSettled,
    });
  });

  it.each(['open', 'rework', 'disputed'])(
    'refuses a %s issue with the exact 05 message',
    (status) => {
      expect(
        checkPayoutApproval(approval({ issueStatuses: ['resolved', status] })),
      ).toEqual({
        ok: false,
        status: 409,
        code: 'STATE_CONFLICT',
        message: 'Resolve the open issue before approving this payout.',
      });
    },
  );

  it('ignores resolved issues', () => {
    expect(
      checkPayoutApproval(approval({ issueStatuses: ['resolved'] })),
    ).toBeNull();
  });

  it('refuses a held request', () => {
    expect(
      checkPayoutApproval(approval({ requestHold: 'staff' })),
    ).toMatchObject({ message: PAYOUT_MESSAGES.requestHold });
  });

  it.each([
    [{ userStatus: 'suspended' }],
    [{ verification: 'delisted' }],
    [{ reliabilityStatus: 'restricted' }],
  ])('refuses a provider who cannot receive payouts (%j)', (change) => {
    expect(
      checkPayoutApproval(
        approval({ provider: { ...activeProvider, ...change } }),
      ),
    ).toMatchObject({ message: PAYOUT_MESSAGES.providerInactive });
  });

  it('refuses with the exact bank message when there is no verified bank, or it is not verified', () => {
    const expected = {
      status: 409,
      message:
        "Verify the provider's bank details before approving this payout.",
    };
    expect(checkPayoutApproval(approval({ bank: null }))).toMatchObject(
      expected,
    );
    expect(
      checkPayoutApproval(
        approval({
          bank: { state: 'superseded', reviewedBy: null, reviewedAt: null },
        }),
      ),
    ).toMatchObject(expected);
  });

  it('blocks approval while a newer bank change is pending', () => {
    expect(
      checkPayoutApproval(approval({ pendingBankChange: true })),
    ).toMatchObject({
      status: 409,
      message: PAYOUT_MESSAGES.bankDetails,
    });
  });

  describe('7-day bank-change separation (Q14)', () => {
    const bank = (ageMs: number, reviewedBy = 'finance-1') => ({
      state: 'verified',
      reviewedBy,
      reviewedAt: new Date(NOW.getTime() - ageMs),
    });

    it('refuses with 403 when the approver reviewed the bank less than 7 days ago', () => {
      expect(checkPayoutApproval(approval({ bank: bank(2 * DAY) }))).toEqual({
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message:
          'Another staff member must approve this payout after the bank change.',
      });
    });

    it('allows the same approver exactly at, and after, the 7-day boundary', () => {
      expect(
        checkPayoutApproval(
          approval({ bank: bank(BANK_CHANGE_SEPARATION_MS) }),
        ),
      ).toBeNull();
      expect(checkPayoutApproval(approval({ bank: bank(8 * DAY) }))).toBeNull();
    });

    it('allows a different approver straight after the change', () => {
      expect(
        checkPayoutApproval(approval({ bank: bank(60_000, 'someone-else') })),
      ).toBeNull();
    });
  });

  it('reports the first failing check in the spec order', () => {
    expect(
      checkPayoutApproval(
        approval({
          requestStatus: 'in_progress',
          issueStatuses: ['open'],
          bank: null,
        }),
      ),
    ).toMatchObject({ message: PAYOUT_MESSAGES.requestNotAcknowledged });
    expect(
      checkPayoutApproval(approval({ issueStatuses: ['open'], bank: null })),
    ).toMatchObject({ message: PAYOUT_MESSAGES.openIssue });
  });
});

describe('needsSecondApproval (PAY-5)', () => {
  it('is off when the threshold is null or not a positive number', () => {
    for (const threshold of [null, undefined, 0, -5, 'big', 1.5])
      expect(needsSecondApproval(10_000_000_000n, threshold)).toBe(false);
  });

  it('applies only to an amount above the threshold, not at it', () => {
    expect(needsSecondApproval(500_001n, 500_000)).toBe(true);
    expect(needsSecondApproval(500_000n, 500_000)).toBe(false);
    expect(needsSecondApproval(499_999n, 500_000)).toBe(false);
  });
});

describe('second approval (Q14, C-18)', () => {
  const first = { step: 1, actorId: 'finance-1', bankVersion: 'b:1' };

  it('refuses the first approver and allows any other payout.approve holder', () => {
    expect(
      checkSecondApprover({ userId: 'finance-1', approvals: [first] }),
    ).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(
      checkSecondApprover({ userId: 'finance-2', approvals: [first] }),
    ).toBeNull();
  });

  it('approving moves to approved, rejecting returns to pending_approval', () => {
    expect(
      planSecondApproval({
        approve: true,
        note: 'ok',
        firstApprovalCurrent: true,
      }),
    ).toEqual({ ok: true, status: 'approved' });
    expect(
      planSecondApproval({
        approve: false,
        note: 'Bank name mismatch.',
        firstApprovalCurrent: true,
      }),
    ).toEqual({ ok: true, status: 'pending_approval' });
  });

  it('needs a note, and a first approval that still covers the current bank', () => {
    expect(
      planSecondApproval({
        approve: true,
        note: '  ',
        firstApprovalCurrent: true,
      }),
    ).toMatchObject({ status: 422, message: PAYOUT_MESSAGES.secondNote });
    expect(
      planSecondApproval({
        approve: true,
        note: 'ok',
        firstApprovalCurrent: false,
      }),
    ).toMatchObject({
      status: 409,
      message: PAYOUT_MESSAGES.bankChangedSinceApproval,
    });
  });

  it('keeps only approvals for the current bank', () => {
    const rows = [
      { step: 1, actorId: 'a', bankVersion: 'bank-1:t1' },
      { step: 1, actorId: 'b', bankVersion: 'bank-2:t2' },
    ];
    expect(currentApprovals(rows, 'bank-2:t2')).toEqual([rows[1]]);
    expect(currentApprovals(rows, null)).toEqual([]);
  });

  it('derives the bank version from the review, not from updatedAt', () => {
    const reviewedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(
      bankVersionOf({
        id: 'bank-1',
        reviewedAt,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ).toBe('bank-1:2026-10-01T00:00:00.000Z');
  });
});

describe('planPrimaryPayout (PAY-4, C-20)', () => {
  const plan = (
    overrides: Partial<Parameters<typeof planPrimaryPayout>[0]> = {},
  ) =>
    planPrimaryPayout({
      now: NOW,
      holidays: [],
      issueStatuses: [],
      provider: activeProvider,
      ...overrides,
    });

  it('is pending approval, due 20 working hours after confirmation', () => {
    const result = plan();

    expect(result).toMatchObject({
      status: 'pending_approval',
      holdSource: null,
      holdReason: null,
    });
    // Monday 11:00 WAT + 20 working hours (two business days of 10 h) = Wednesday 11:00 WAT.
    expect(result.approvalDueAt.toISOString()).toBe('2026-10-28T10:00:00.000Z');
  });

  it('skips public holidays when it counts the 20 hours', () => {
    expect(plan({ holidays: ['2026-10-27'] }).approvalDueAt.toISOString()).toBe(
      '2026-10-29T10:00:00.000Z',
    );
  });

  it.each(['open', 'rework', 'disputed'])(
    'starts on_hold with source issue for a %s issue',
    (status) => {
      expect(plan({ issueStatuses: [status] })).toMatchObject({
        status: 'on_hold',
        holdSource: 'issue',
        holdReason: expect.any(String) as string,
      });
    },
  );

  it('ignores resolved issues', () => {
    expect(plan({ issueStatuses: ['resolved'] }).status).toBe(
      'pending_approval',
    );
  });

  it.each([
    [{ userStatus: 'suspended' }],
    [{ verification: 'delisted' }],
    [{ reliabilityStatus: 'restricted' }],
  ])(
    'starts on_hold with source suspension when the provider is blocked (%j)',
    (change) => {
      expect(
        plan({ provider: { ...activeProvider, ...change } }),
      ).toMatchObject({ status: 'on_hold', holdSource: 'suspension' });
    },
  );

  it('prefers the issue source when both apply', () => {
    expect(
      plan({
        issueStatuses: ['open'],
        provider: { ...activeProvider, userStatus: 'suspended' },
      }).holdSource,
    ).toBe('issue');
  });
});

describe('holdAction and checkRelease (05 §5, §6.6)', () => {
  it.each([
    'pending_approval',
    'awaiting_second_approval',
    'approved',
    'failed',
  ])('holds a %s payout', (status) => {
    expect(holdAction(status)).toBe('hold');
  });

  it('flags a processing transfer instead of holding it', () => {
    expect(holdAction('processing')).toBe('flag');
  });

  it.each(['paid', 'cancelled', 'reversed', 'on_hold'])(
    'cannot hold a %s payout',
    (status) => {
      expect(holdAction(status)).toBeNull();
    },
  );

  const release = (
    overrides: Partial<Parameters<typeof checkRelease>[0]> = {},
  ) =>
    checkRelease({
      issueStatuses: [],
      requestHold: null,
      provider: activeProvider,
      holdSource: 'manual',
      pendingBankChange: false,
      ...overrides,
    });

  it('allows a release once the cause is gone', () => {
    expect(release()).toBeNull();
  });

  it('refuses while an issue, a request hold or a suspension remains', () => {
    for (const blocked of [
      { issueStatuses: ['disputed'] },
      { requestHold: 'staff' },
      { provider: { ...activeProvider, userStatus: 'suspended' } },
    ])
      expect(release(blocked)).toMatchObject({
        message: PAYOUT_MESSAGES.releaseBlocked,
      });
  });

  it('refuses a bank_change hold while the new bank is still pending', () => {
    expect(
      release({ holdSource: 'bank_change', pendingBankChange: true }),
    ).toMatchObject({ message: PAYOUT_MESSAGES.bankDetails });
    expect(
      release({ holdSource: 'manual', pendingBankChange: true }),
    ).toBeNull();
  });
});

describe('closureStateOf (04 §6.17, C-18)', () => {
  const row = (
    status: string,
    overrides: Partial<{ kind: string; holdReason: string | null }> = {},
  ) => ({ kind: 'primary', status, holdReason: null, ...overrides });

  it('is paid when the primary payout is paid', () => {
    expect(closureStateOf([row('paid')])).toEqual({ state: 'paid' });
  });

  it('accepts on_hold only with a recorded reason', () => {
    expect(
      closureStateOf([row('on_hold', { holdReason: 'Open customer issue' })]),
    ).toEqual({
      state: 'on_hold_with_reason',
      reason: 'Open customer issue',
    });
    expect(
      closureStateOf([row('on_hold', { holdReason: '  ' })]),
    ).toMatchObject({ state: 'blocked' });
    expect(closureStateOf([row('on_hold')])).toMatchObject({
      state: 'blocked',
    });
  });

  it.each([
    'pending_approval',
    'awaiting_second_approval',
    'approved',
    'processing',
    'failed',
    'reversed',
  ])('blocks closure for a %s payout', (status) => {
    expect(closureStateOf([row(status)])).toMatchObject({ state: 'blocked' });
  });

  it('does not let a cancelled primary payout satisfy closure', () => {
    expect(closureStateOf([row('cancelled')])).toMatchObject({
      state: 'blocked',
      reason: 'No provider payout has been created.',
    });
  });

  it('ignores a cancelled payout when a replacement one exists', () => {
    expect(closureStateOf([row('cancelled'), row('paid')])).toEqual({
      state: 'paid',
    });
  });

  it('is blocked when there is no payout, and ignores compensation payouts', () => {
    expect(closureStateOf([])).toMatchObject({ state: 'blocked' });
    expect(
      closureStateOf([row('paid', { kind: 'compensation' })]),
    ).toMatchObject({ state: 'blocked' });
  });
});

describe('transfer reference (FD-8, C-23)', () => {
  it('is xpro_tr_ plus 32 lowercase hex characters, 40 in total', () => {
    const reference = newTransferReference();

    expect(reference).toHaveLength(40);
    expect(reference).toMatch(TRANSFER_REFERENCE_PATTERN);
    expect(reference).toBe(reference.toLowerCase());
  });

  it('is built from a uuid without dashes and never repeats', () => {
    expect(
      newTransferReference(() => '0123ABCD-4567-89ab-CDEF-0123456789ab'),
    ).toBe('xpro_tr_0123abcd456789abcdef0123456789ab');
    expect(newTransferReference()).not.toBe(newTransferReference());
  });
});

describe('classifyGatewayTransfer', () => {
  it.each([
    ['success', 'success'],
    ['SUCCESS', 'success'],
    ['failed', 'failed'],
    ['rejected', 'failed'],
    ['blocked', 'failed'],
    ['abandoned', 'failed'],
    ['reversed', 'reversed'],
    ['otp', 'otp'],
    ['pending', 'in_flight'],
    ['received', 'in_flight'],
    ['processing', 'in_flight'],
    ['something-new', 'in_flight'],
  ])('reads %s as %s', (status, expected) => {
    expect(classifyGatewayTransfer(status)).toBe(expected);
  });
});

describe('decideTransferRetry (C-05, 05 §7)', () => {
  const longAgo = new Date(NOW.getTime() - 10 * 60_000);
  const decide = (
    overrides: Partial<Parameters<typeof decideTransferRetry>[0]> = {},
  ) =>
    decideTransferRetry({
      payoutStatus: 'processing',
      offline: false,
      latestAttempt: { status: 'pending', submittedAt: longAgo },
      verified: null,
      now: NOW,
      ...overrides,
    });

  it('resubmits when Paystack does not know the earlier reference', () => {
    expect(decide()).toEqual({ action: 'resubmit', previous: 'not_found' });
  });

  it('resubmits only after Paystack confirms failed or reversed', () => {
    expect(decide({ verified: { status: 'failed' } })).toEqual({
      action: 'resubmit',
      previous: 'failed',
    });
    expect(decide({ verified: { status: 'reversed' } })).toEqual({
      action: 'resubmit',
      previous: 'reversed',
    });
    expect(
      decide({ payoutStatus: 'failed', verified: { status: 'failed' } }),
    ).toEqual({ action: 'resubmit', previous: 'failed' });
  });

  it('settles instead of resubmitting when the earlier transfer succeeded', () => {
    expect(decide({ verified: { status: 'success' } })).toEqual({
      action: 'settle',
      outcome: 'success',
    });
  });

  it.each(['pending', 'processing', 'otp', 'received'])(
    'waits while Paystack reports %s',
    (status) => {
      expect(decide({ verified: { status } })).toMatchObject({
        action: 'wait',
        message: PAYOUT_MESSAGES.stillWithPaystack,
      });
    },
  );

  it('waits, without resubmitting, while the first call may still be in flight', () => {
    expect(
      decide({
        latestAttempt: {
          status: 'pending',
          submittedAt: new Date(NOW.getTime() - TRANSFER_RETRY_COOLDOWN_MS + 1),
        },
      }),
    ).toMatchObject({ action: 'wait' });
    expect(
      decide({
        latestAttempt: {
          status: 'pending',
          submittedAt: new Date(NOW.getTime() - TRANSFER_RETRY_COOLDOWN_MS),
        },
      }),
    ).toEqual({ action: 'resubmit', previous: 'not_found' });
  });

  it.each([
    [{ payoutStatus: 'paid' }],
    [{ payoutStatus: 'approved' }],
    [{ payoutStatus: 'cancelled' }],
    [{ offline: true }],
    [{ latestAttempt: null }],
  ])('refuses %j', (change) => {
    expect(decide(change)).toEqual({
      action: 'refuse',
      message: PAYOUT_MESSAGES.notRetryable,
    });
  });
});

describe('planTransferEvent (C-19)', () => {
  const event = (
    overrides: Partial<Parameters<typeof planTransferEvent>[0]> = {},
  ) =>
    planTransferEvent({
      outcome: 'success',
      attemptId: 'attempt-2',
      latestAttemptId: 'attempt-2',
      attemptAmount: 9_000_000n,
      payoutAmount: 9_000_000n,
      ...overrides,
    });

  it('applies success, failed and reversed events for the latest attempt', () => {
    expect(event().payout).toEqual({
      to: 'paid',
      from: ['processing', 'failed'],
    });
    expect(event({ outcome: 'failed' }).payout).toEqual({
      to: 'failed',
      from: ['processing'],
    });
    expect(event({ outcome: 'reversed' }).payout).toEqual({
      to: 'reversed',
      from: ['processing', 'paid'],
    });
  });

  it('records the attempt but leaves the payout alone for an earlier attempt', () => {
    expect(event({ outcome: 'failed', attemptId: 'attempt-1' })).toEqual({
      attemptStatus: 'failed',
      payout: null,
      reason: 'not_latest',
    });
  });

  it('leaves the payout alone when the amount differs', () => {
    expect(event({ attemptAmount: 8_000_000n })).toMatchObject({
      payout: null,
      reason: 'amount_mismatch',
    });
    expect(event({ verifiedAmount: 1_000 })).toMatchObject({
      payout: null,
      reason: 'amount_mismatch',
    });
    expect(event({ verifiedAmount: 9_000_000 }).payout).not.toBeNull();
    expect(event({ verifiedAmount: null }).payout).not.toBeNull();
  });

  it('never marks a payout paid from a failed or reversed payout state it should not leave', () => {
    expect(event({ outcome: 'failed' }).payout?.from).not.toContain('paid');
    expect(event().payout?.from).not.toContain('cancelled');
  });
});

describe('parseStatusFilter', () => {
  const allowed = ['pending_approval', 'paid'] as const;

  it('returns no filter when absent', () => {
    expect(parseStatusFilter(undefined, allowed)).toEqual({
      ok: true,
      status: undefined,
    });
    expect(parseStatusFilter('', allowed)).toEqual({
      ok: true,
      status: undefined,
    });
  });

  it('accepts an allowed value and refuses any other with 422', () => {
    expect(parseStatusFilter('paid', allowed)).toEqual({
      ok: true,
      status: 'paid',
    });
    expect(parseStatusFilter('nope', allowed)).toMatchObject({
      ok: false,
      status: 422,
      message: PAYOUT_MESSAGES.badStatusFilter,
    });
  });
});
