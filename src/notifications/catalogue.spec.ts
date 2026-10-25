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
});
