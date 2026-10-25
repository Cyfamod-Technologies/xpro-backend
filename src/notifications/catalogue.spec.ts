import { NOTIFICATION_CATALOGUE, renderNotification } from './catalogue';

describe('notification catalogue', () => {
  it('keys every entry by its own event key', () => {
    for (const [key, definition] of Object.entries(NOTIFICATION_CATALOGUE)) {
      expect(definition.key).toBe(key);
    }
  });

  it('renders a customer event with the spec title and a mandatory flag', () => {
    expect(
      renderNotification('request.received', { requestCode: 'XPR-00042' }),
    ).toEqual({
      event: 'request.received',
      audience: { kind: 'customer' },
      mandatory: true,
      title: 'Request received',
      message: 'We have received your request XPR-00042.',
      link: '/requests',
    });
  });

  it('renders a staff event that is not mandatory', () => {
    const rendered = renderNotification('request.needs_owner', {
      requestCode: 'XPR-00042',
    });
    expect(rendered).toMatchObject({
      audience: { kind: 'staff:info' },
      mandatory: false,
      title: 'Request needs an owner',
      link: '/admin/requests?owner=unclaimed',
    });
  });

  it('renders the 04 §6.11 quote decision notifications', () => {
    const code = { requestCode: 'XPR-00042' };
    expect(
      renderNotification('quote.payment_due', {
        ...code,
        amount: 50_000_000,
        dueDate: '31/10/2026',
      }),
    ).toMatchObject({
      audience: { kind: 'customer' },
      mandatory: true,
      title: 'Payment due',
      message: 'Pay ₦500,000 for XPR-00042 by 31/10/2026 to book your date.',
    });
    expect(
      renderNotification('quote.accepted', {
        ...code,
        amount: 1,
        dueDate: '31/10/2026',
      }),
    ).toMatchObject({
      audience: { kind: 'staff:gated', permission: 'payment.record' },
      title: 'Quote accepted, awaiting payment',
    });
    expect(renderNotification('quote.accepted_provider', code)).toMatchObject({
      audience: { kind: 'provider:current' },
      title: 'Customer accepted the quote',
      message: 'XPro will confirm the date once the customer has paid.',
    });
    expect(
      renderNotification('quote.changes_requested_provider', code),
    ).toMatchObject({
      title: 'Customer asked for changes',
      message: 'XPro may ask you to update your costing.',
    });
    expect(renderNotification('quote.declined', code)).toMatchObject({
      audience: { kind: 'staff:gated', permission: 'request.cancel' },
      title: 'Quote declined — cancellation requested',
    });
  });

  it('uses the 04 §6.12 payment window copy', () => {
    expect(
      renderNotification('payment.reminder', {
        requestCode: 'XPR-00042',
        amount: 50_000_000,
        dueDate: '31/10/2026',
      }),
    ).toMatchObject({
      title: 'Payment reminder',
      message: 'Pay ₦500,000 for XPR-00042 by 31/10/2026 to book your date.',
    });
    expect(
      renderNotification('payment.lapsed', { requestCode: 'XPR-00042' }),
    ).toMatchObject({
      title: 'Payment window closed',
      message:
        "Your quote for XPR-00042 expired because payment wasn't received. XPro will contact you.",
    });
    expect(
      renderNotification('payment.settled_staff', { requestCode: 'XPR-00042' }),
    ).toMatchObject({
      audience: { kind: 'staff:gated', permission: 'schedule.manage' },
      title: 'Paid — schedule it',
    });
  });

  it('renders the refund and cancellation-complete notices', () => {
    const code = { requestCode: 'XPR-00042' };
    expect(
      renderNotification('refund.requested', { ...code, amount: 50_000_000 }),
    ).toMatchObject({
      audience: { kind: 'staff:holders', permission: 'refund.manage' },
      mandatory: true,
      title: 'Refund to decide',
      message: 'XPR-00042: a refund of ₦500,000 is waiting for a decision.',
    });
    expect(renderNotification('refund.rejected', code)).toMatchObject({
      audience: { kind: 'staff:holders', permission: 'refund.manage' },
      title: 'Refund rejected',
    });
    expect(
      renderNotification('refund.failed', {
        ...code,
        amount: 50_000_000,
        detail: 'Paystack refused it.',
      }),
    ).toMatchObject({
      audience: { kind: 'staff:all_holders', permission: 'refund.manage' },
      mandatory: true,
      title: 'Refund needs attention',
    });
    expect(
      renderNotification('cancellation.completed_customer', code),
    ).toMatchObject({
      audience: { kind: 'customer' },
      mandatory: true,
      title: 'Request cancelled',
    });
    expect(
      renderNotification('cancellation.completed_provider', {
        ...code,
        assignmentId: 'assignment-1',
        providerUserId: 'provider-1',
      }),
    ).toMatchObject({
      audience: { kind: 'provider:assignment' },
      title: 'Request cancelled',
      link: null,
    });
  });

  it('renders the payout notices for the provider and Finance (C-19)', () => {
    const provider = {
      requestCode: 'XPR-00042',
      assignmentId: 'assignment-1',
      providerUserId: 'provider-1',
    };
    expect(
      renderNotification('payout.paid', { ...provider, amount: 9_000_000 }),
    ).toMatchObject({
      audience: { kind: 'provider:assignment' },
      mandatory: true,
      title: 'Payout sent',
      message:
        'XPR-00042: your payout of ₦90,000 has been sent to your bank account.',
    });
    expect(renderNotification('payout.failed', provider)).toMatchObject({
      audience: { kind: 'provider:assignment' },
      title: 'Payout delayed',
    });
    expect(
      renderNotification('payout.reversed', { ...provider, amount: 9_000_000 }),
    ).toMatchObject({
      audience: { kind: 'provider:assignment' },
      title: 'Payout returned',
    });
    expect(
      renderNotification('payout.finance_update', {
        requestCode: 'XPR-00042',
        amount: 9_000_000,
        outcome: 'failed',
      }),
    ).toMatchObject({
      audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
      mandatory: true,
      title: 'Payout failed',
    });
    expect(
      renderNotification('payout.needs_attention', {
        requestCode: 'XPR-00042',
        amount: 9_000_000,
        detail: 'Paystack did not confirm it.',
      }),
    ).toMatchObject({
      audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
      title: 'Payout needs attention',
    });
  });
  describe('05 §9 money notices (C-24)', () => {
    const code = { requestCode: 'XPR-00042' };
    const provider = {
      ...code,
      assignmentId: 'assignment-1',
      providerUserId: 'provider-1',
    };

    it('marks every money event Mandatory: Yes, and no other money event exists without a flag', () => {
      const moneyEvents = Object.values(NOTIFICATION_CATALOGUE).filter(
        ({ key }) =>
          /^(payment|refund|payout|gateway)\./.test(key) &&
          !key.startsWith('payment.reminder') &&
          !key.startsWith('payment.lapsed') &&
          !key.startsWith('payment.settled_staff') &&
          !key.startsWith('payment.settled_provider'),
      );
      expect(moneyEvents.map(({ key }) => key).sort()).toEqual(
        expect.arrayContaining([
          'payment.failed_customer',
          'payment.late',
          'payment.late_customer',
          'payment.offline_recorded',
          'payment.quarantined',
          'payment.settled_customer',
          'payout.created',
          'payout.held',
          'payout.paid',
          'payout.released',
          'payout.second_approval_needed',
          'refund.approved_customer',
          'refund.completed',
          'refund.completed_customer',
          'refund.decided',
          'refund.mismatch',
          'refund.requested',
        ]),
      );
      for (const entry of moneyEvents)
        expect([entry.key, entry.mandatory]).toEqual([entry.key, true]);
    });

    it('tells the customer about a failed payment, a late payment and their refund', () => {
      expect(renderNotification('payment.failed_customer', code)).toMatchObject(
        {
          audience: { kind: 'customer' },
          mandatory: true,
          title: 'Payment not completed',
        },
      );
      expect(renderNotification('payment.late_customer', code)).toMatchObject({
        audience: { kind: 'customer' },
        mandatory: true,
        title: 'Payment received late',
      });
      expect(
        renderNotification('refund.approved_customer', {
          ...code,
          amount: 50_000_000,
        }),
      ).toMatchObject({
        audience: { kind: 'customer' },
        mandatory: true,
        message:
          'XPR-00042: your refund of ₦500,000 was approved and is being processed.',
      });
      expect(
        renderNotification('refund.completed_customer', {
          ...code,
          amount: 50_000_000,
        }),
      ).toMatchObject({
        audience: { kind: 'customer' },
        mandatory: true,
        title: 'Refund completed',
      });
    });

    it('sends refund decisions and completions to Finance and Super admins, second approvals included', () => {
      for (const outcome of [
        'approved',
        'rejected',
        'waived',
        'awaiting_second_approval',
      ] as const)
        expect(
          renderNotification('refund.decided', { ...code, outcome, amount: 1 }),
        ).toMatchObject({
          audience: { kind: 'staff:all_holders', permission: 'refund.manage' },
          mandatory: true,
        });
      expect(
        renderNotification('refund.decided', {
          ...code,
          outcome: 'awaiting_second_approval',
          amount: 12_000_000,
        }).message,
      ).toBe(
        'XPR-00042: the refund of ₦120,000 was approved after work started. A Super admin must give the second approval.',
      );
      expect(
        renderNotification('refund.completed', { ...code, amount: 1 }),
      ).toMatchObject({
        audience: { kind: 'staff:all_holders', permission: 'refund.manage' },
        mandatory: true,
      });
      expect(
        renderNotification('refund.mismatch', {
          ...code,
          approvedAmount: 50_000_000,
          reportedAmount: 100,
        }),
      ).toMatchObject({
        audience: { kind: 'staff:all_holders', permission: 'refund.manage' },
        mandatory: true,
        title: 'Refund needs manual reconciliation',
      });
    });

    it('treats a late payment as mandatory for Finance', () => {
      expect(
        renderNotification('payment.late', { ...code, reference: 'xpro_1' }),
      ).toMatchObject({ mandatory: true });
    });

    it('announces a created payout and its second approval to Finance', () => {
      expect(
        renderNotification('payout.created', {
          ...code,
          amount: 9_000_000,
          dueDate: '28/10/2026',
          onHold: false,
        }),
      ).toMatchObject({
        audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
        mandatory: true,
        message:
          'XPR-00042: a payout of ₦90,000 is ready for first approval by 28/10/2026.',
      });
      expect(
        renderNotification('payout.created', {
          ...code,
          amount: 9_000_000,
          dueDate: '28/10/2026',
          onHold: true,
        }).message,
      ).toContain('created on hold');
      expect(
        renderNotification('payout.second_approval_needed', {
          ...code,
          amount: 9_000_000,
        }),
      ).toMatchObject({
        audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
        mandatory: true,
        title: 'Payout needs a second approval',
      });
    });

    it('tells the provider about a hold and its release, and Finance about both', () => {
      expect(
        renderNotification('payout.held', {
          ...provider,
          reason: 'On hold while XPro Finance reviews this payout.',
        }),
      ).toMatchObject({
        audience: { kind: 'provider:assignment' },
        mandatory: true,
        title: 'Payout on hold',
        message: 'XPR-00042: On hold while XPro Finance reviews this payout.',
      });
      expect(renderNotification('payout.released', provider)).toMatchObject({
        audience: { kind: 'provider:assignment' },
        mandatory: true,
        title: 'Payout back in review',
      });
      for (const [outcome, title] of [
        ['held', 'Payout held'],
        ['released', 'Payout released'],
      ] as const)
        expect(
          renderNotification('payout.finance_update', {
            ...code,
            amount: 9_000_000,
            outcome,
          }),
        ).toMatchObject({
          audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
          mandatory: true,
          title,
        });
    });
  });
});
