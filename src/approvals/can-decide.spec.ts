import {
  BLOCKED_REASONS,
  decidingPermissionFor,
  evaluateCanDecide,
  type Caller,
  type DecisionFacts,
} from './can-decide';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const caller = (
  permissions: string[],
  overrides: Partial<Caller> = {},
): Caller => ({
  userId: 'me',
  permissions: new Set(permissions),
  canOwn: false,
  isSuperAdmin: false,
  ...overrides,
});

const decide = (
  kind: string,
  who: Caller,
  facts: DecisionFacts = {},
  now = NOW,
) => evaluateCanDecide({ kind, caller: who, facts, now });

describe('canDecide (02 §4.6, §6.11, §6.14)', () => {
  describe('the deciding permission', () => {
    it.each([
      ['intake', 'request.review'],
      ['needs_assignment', 'dispatch.manage'],
      ['quote_build', 'quote.manage'],
      ['quote_approval', 'quote.approve'],
      ['schedule_needed', 'schedule.manage'],
      ['progress', 'progress.review'],
      ['completion_issue', 'issue.resolve'],
      ['ready_to_close', 'request.close'],
      ['escalation', 'request.escalation.resolve'],
      ['provider_reliability', 'provider.review'],
      ['offline_payment', 'payment.record'],
      ['refund', 'refund.manage'],
      ['payout', 'payout.approve'],
      ['payout_second', 'payout.approve'],
    ])('%s needs %s', (kind, permission) => {
      expect(decide(kind, caller([permission]))).toMatchObject({
        decidingPermission: permission,
        canDecide: true,
        blockedReason: null,
      });
      expect(decide(kind, caller(['message.internal']))).toEqual({
        decidingPermission: permission,
        canDecide: false,
        blockedReason: null,
      });
    });

    it('needs the ability to own requests for an unclaimed item', () => {
      expect(decide('unclaimed', caller(['request.claim']))).toMatchObject({
        canDecide: false,
      });
      expect(
        decide('unclaimed', caller(['request.claim'], { canOwn: true })),
      ).toMatchObject({ canDecide: true });
    });

    it('asks for request.cancel.active once the job is paid or started', () => {
      const cancel = caller(['request.cancel']);
      expect(decide('cancellation', cancel)).toMatchObject({
        decidingPermission: 'request.cancel',
        canDecide: true,
      });
      for (const flags of [
        { paid: true, workStarted: false },
        { paid: false, workStarted: true },
      ]) {
        const facts = { cancellation: flags };
        expect(decidingPermissionFor('cancellation', facts)).toBe(
          'request.cancel.active',
        );
        expect(decide('cancellation', cancel, facts).canDecide).toBe(false);
        expect(
          decide(
            'cancellation',
            caller(['request.cancel', 'request.cancel.active']),
            facts,
          ).canDecide,
        ).toBe(true);
      }
    });
  });

  describe('quote sign-off: approver is not the last editor', () => {
    const approver = caller(['quote.approve']);

    it('blocks the last editor while another approver exists', () => {
      expect(
        decide('quote_approval', approver, {
          quote: { lastEditedBy: 'me', otherApprovers: 1 },
        }),
      ).toEqual({
        decidingPermission: 'quote.approve',
        canDecide: false,
        blockedReason: 'You edited this quote last.',
      });
    });

    it('lets the last editor approve when nobody else can (02 §6.12 self-approval)', () => {
      expect(
        decide('quote_approval', approver, {
          quote: { lastEditedBy: 'me', otherApprovers: 0 },
        }).canDecide,
      ).toBe(true);
    });

    it('lets someone else approve', () => {
      expect(
        decide('quote_approval', approver, {
          quote: { lastEditedBy: 'other', otherApprovers: 2 },
        }).canDecide,
      ).toBe(true);
    });
  });

  describe('offline payment: recorder is not the reconciler', () => {
    const finance = caller(['payment.record']);

    it('blocks the person who recorded it', () => {
      expect(
        decide('offline_payment', finance, { payment: { recordedBy: 'me' } }),
      ).toMatchObject({
        canDecide: false,
        blockedReason: BLOCKED_REASONS.recorder,
      });
    });

    it('lets another Finance user reconcile', () => {
      expect(
        decide('offline_payment', finance, {
          payment: { recordedBy: 'other' },
        }).canDecide,
      ).toBe(true);
    });
  });

  describe('refund: requester is not the decider', () => {
    const finance = caller(['refund.manage']);
    const refund = (patch: Partial<NonNullable<DecisionFacts['refund']>>) => ({
      refund: {
        status: 'pending_approval',
        requestedBy: 'other',
        decidedBy: null,
        transferRecordedBy: null,
        ...patch,
      },
    });

    it('blocks the requester from the first decision', () => {
      expect(
        decide('refund', finance, refund({ requestedBy: 'me' })),
      ).toMatchObject({
        canDecide: false,
        blockedReason: BLOCKED_REASONS.refundRequester,
      });
      expect(decide('refund', finance, refund({})).canDecide).toBe(true);
    });

    it('needs a super admin who is not the first decider for the second approval', () => {
      const second = refund({
        status: 'awaiting_second_approval',
        decidedBy: 'me',
      });
      expect(decide('refund', finance, second).blockedReason).toBe(
        BLOCKED_REASONS.refundSecondRole,
      );
      const admin = caller(['refund.manage'], { isSuperAdmin: true });
      expect(decide('refund', admin, second).blockedReason).toBe(
        BLOCKED_REASONS.refundFirstApprover,
      );
      expect(
        decide(
          'refund',
          admin,
          refund({ status: 'awaiting_second_approval', decidedBy: 'other' }),
        ).canDecide,
      ).toBe(true);
    });

    it('blocks whoever recorded the transfer or requested the refund from reconciling it', () => {
      for (const patch of [{ transferRecordedBy: 'me' }, { requestedBy: 'me' }])
        expect(
          decide('refund', finance, refund({ status: 'approved', ...patch }))
            .blockedReason,
        ).toBe(BLOCKED_REASONS.refundReconciler);
      expect(
        decide('refund', finance, refund({ status: 'approved' })).canDecide,
      ).toBe(true);
    });
  });

  describe('payout: the bank-change rule and first-not-second approver', () => {
    const approver = caller(['payout.approve']);

    it('blocks the person who reviewed the bank details within 7 days', () => {
      const recent = new Date(NOW.getTime() - 3 * DAY);
      expect(
        decide('payout', approver, {
          payout: {
            approvals: [],
            bank: { reviewedBy: 'me', reviewedAt: recent },
          },
        }),
      ).toMatchObject({
        canDecide: false,
        blockedReason: BLOCKED_REASONS.bankChange,
      });
    });

    it('lets them approve once the 7 days have passed, or when someone else reviewed the bank', () => {
      const old = new Date(NOW.getTime() - 8 * DAY);
      expect(
        decide('payout', approver, {
          payout: {
            approvals: [],
            bank: { reviewedBy: 'me', reviewedAt: old },
          },
        }).canDecide,
      ).toBe(true);
      expect(
        decide('payout', approver, {
          payout: {
            approvals: [],
            bank: {
              reviewedBy: 'other',
              reviewedAt: new Date(NOW.getTime() - DAY),
            },
          },
        }).canDecide,
      ).toBe(true);
    });

    it('blocks the first approver from the second approval', () => {
      expect(
        decide('payout_second', approver, {
          payout: { approvals: [{ step: 1, actorId: 'me' }], bank: null },
        }),
      ).toMatchObject({
        canDecide: false,
        blockedReason: BLOCKED_REASONS.payoutFirstApprover,
      });
      expect(
        decide('payout_second', approver, {
          payout: { approvals: [{ step: 1, actorId: 'other' }], bank: null },
        }).canDecide,
      ).toBe(true);
    });
  });

  describe('escalation: raiser is not the resolver', () => {
    const resolver = caller(['request.escalation.resolve']);

    it('blocks the raiser unless they are a super admin', () => {
      const facts = { escalation: { to: 'operations', raisedBy: 'me' } };
      expect(decide('escalation', resolver, facts)).toMatchObject({
        canDecide: false,
        blockedReason: BLOCKED_REASONS.escalationRaiser,
      });
      expect(
        decide(
          'escalation',
          caller(['request.escalation.resolve'], { isSuperAdmin: true }),
          facts,
        ).canDecide,
      ).toBe(true);
    });

    it('leaves an escalation to super admins to super admins', () => {
      const facts = { escalation: { to: 'super_admin', raisedBy: 'other' } };
      expect(decide('escalation', resolver, facts).blockedReason).toBe(
        BLOCKED_REASONS.escalationSuperAdmin,
      );
      expect(
        decide(
          'escalation',
          caller(['request.escalation.resolve'], { isSuperAdmin: true }),
          facts,
        ).canDecide,
      ).toBe(true);
    });

    it('lets another holder resolve a system escalation to operations', () => {
      expect(
        decide('escalation', resolver, {
          escalation: { to: 'operations', raisedBy: null },
        }).canDecide,
      ).toBe(true);
    });
  });

  it('blocks staff from deciding items on their own customer request (02 §6.14 rule 7)', () => {
    expect(
      decide('intake', caller(['request.review']), { requestOwnerId: 'me' }),
    ).toMatchObject({
      canDecide: false,
      blockedReason: BLOCKED_REASONS.ownRequest,
    });
  });

  it('gives no reason to a caller who lacks the permission', () => {
    expect(
      decide('refund', caller([]), {
        refund: {
          status: 'pending_approval',
          requestedBy: 'me',
          decidedBy: null,
          transferRecordedBy: null,
        },
      }),
    ).toEqual({
      decidingPermission: 'refund.manage',
      canDecide: false,
      blockedReason: null,
    });
  });
});
