import { allowedActions } from './allowed-actions';
import {
  assignment,
  customer,
  HOUR,
  NOW,
  provider,
  quote,
  schedule,
  snapshot,
  staff,
} from './guard.testkit';
import { REQUEST_GUARDS } from './request-guard-registry';
import type { ActorView, RequestSnapshot } from './snapshot';
import { deriveStage, nextActor, type RequestStage } from './stage';

const actionsFor = (snap: RequestSnapshot, actor: ActorView) =>
  allowedActions(snap, actor, NOW, {}, REQUEST_GUARDS);

const approved = {
  intake: { state: 'approved' as const },
  currentProviderUserId: 'provider-1',
  providerStanding: 'active' as const,
};
const withProvider = (overrides: Partial<RequestSnapshot> = {}) =>
  snapshot({
    ...approved,
    currentAssignment: assignment('accepted'),
    ...overrides,
  });
const accepted = quote('accepted', {
  validUntil: new Date(NOW.getTime() + HOUR),
});
const sent = quote('sent', { validUntil: new Date(NOW.getTime() + 24 * HOUR) });

const ops = staff(
  'request.review',
  'request.clarify',
  'request.claim',
  'dispatch.manage',
  'schedule.manage',
  'progress.review',
  'issue.resolve',
  'request.close',
  'request.cancel',
  'request.escalate',
);
const pricing = staff('quote.manage', 'view.pricing', 'request.escalate');
const superAdmin = staff(
  ...ops.permissions!,
  'quote.manage',
  'quote.approve',
  'view.pricing',
  'payment.record',
);

type Row = {
  stage: RequestStage;
  next: string;
  snap: RequestSnapshot;
  actor: ActorView;
  expects: string[];
};

/** One row per stage of 04 §5.3 whose "Next actor" is a person the registry covers (`refund_pending` belongs to 05). */
const rows: Row[] = [
  {
    stage: 'intake_review',
    next: 'staff:request.review',
    snap: snapshot({ status: 'submitted' }),
    actor: ops,
    expects: ['request.review', 'request.reject', 'request.clarify'],
  },
  {
    stage: 'awaiting_clarification',
    next: 'customer',
    snap: snapshot({ status: 'submitted', intake: { state: 'clarification' } }),
    actor: customer(),
    expects: ['request.update', 'request.cancel'],
  },
  {
    stage: 'dispatching',
    next: 'staff:dispatch.manage',
    snap: snapshot({ status: 'under_review', ...approved }),
    actor: ops,
    expects: ['assignment.auto', 'assignment.offer', 'dispatch.runs'],
  },
  {
    stage: 'offer_out',
    next: 'provider',
    snap: snapshot({
      status: 'under_review',
      ...approved,
      currentAssignment: assignment('offered'),
    }),
    actor: provider(),
    expects: ['assignment.respond'],
  },
  {
    stage: 'offer_out',
    next: 'provider',
    snap: snapshot({
      status: 'under_review',
      ...approved,
      currentAssignment: assignment('offered'),
    }),
    actor: ops,
    expects: ['assignment.withdraw'],
  },
  {
    stage: 'acceptance_review',
    next: 'staff:dispatch.manage',
    snap: snapshot({
      status: 'under_review',
      ...approved,
      currentAssignment: assignment('pending_approval'),
    }),
    actor: ops,
    expects: ['assignment.review', 'assignment.withdraw'],
  },
  {
    stage: 'replacing_provider',
    next: 'staff:dispatch.manage',
    snap: snapshot({
      status: 'under_review',
      ...approved,
      latestQuote: accepted,
      quotes: [accepted],
    }),
    actor: ops,
    expects: ['assignment.auto', 'assignment.offer'],
  },
  {
    stage: 'pricing',
    next: 'provider',
    snap: withProvider({ status: 'matched' }),
    actor: provider(),
    expects: ['quote.contribute'],
  },
  {
    stage: 'pricing',
    next: 'staff:quote.manage',
    snap: withProvider({ status: 'matched', providerCostingSubmitted: true }),
    actor: pricing,
    expects: ['quote.save', 'quote.publish'],
  },
  {
    stage: 'quote_approval',
    next: 'staff:quote.approve',
    snap: withProvider({
      status: 'matched',
      latestQuote: quote('draft', { approvalRequestedAt: NOW }),
      quotes: [quote('draft', { approvalRequestedAt: NOW })],
    }),
    actor: superAdmin,
    expects: ['quote.approve', 'quote.return'],
  },
  {
    stage: 'quote_revision',
    next: 'staff:quote.manage',
    snap: withProvider({
      status: 'matched',
      latestQuote: quote('revision_requested'),
      quotes: [quote('revision_requested')],
    }),
    actor: pricing,
    expects: ['quote.save', 'quote.publish'],
  },
  {
    stage: 'quote_expired',
    next: 'staff:quote.manage',
    snap: withProvider({
      status: 'matched',
      latestQuote: quote('expired'),
      quotes: [quote('expired')],
    }),
    actor: pricing,
    expects: ['quote.save', 'quote.publish'],
  },
  {
    stage: 'payment_lapsed',
    next: 'staff:quote.manage',
    snap: withProvider({
      status: 'matched',
      latestQuote: quote('expired', { validUntil: null }),
      quotes: [quote('expired')],
      paymentLapsed: true,
    }),
    actor: pricing,
    expects: ['quote.save', 'quote.publish'],
  },
  {
    stage: 'quote_with_customer',
    next: 'customer',
    snap: withProvider({
      status: 'quoted',
      latestQuote: sent,
      latestSentQuote: sent,
      quotes: [sent],
    }),
    actor: customer(),
    expects: ['quote.respond', 'cancellation.request'],
  },
  {
    stage: 'awaiting_payment',
    next: 'customer',
    snap: withProvider({
      status: 'awaiting_payment',
      latestQuote: accepted,
      quotes: [accepted],
    }),
    actor: customer(),
    expects: ['payment.initiate'],
  },
  {
    stage: 'awaiting_payment',
    next: 'customer',
    snap: withProvider({
      status: 'awaiting_payment',
      latestQuote: accepted,
      quotes: [accepted],
    }),
    actor: superAdmin,
    expects: ['payment.recordOffline', 'assignment.replace'],
  },
  {
    stage: 'set_payout',
    next: 'staff:quote.manage',
    snap: withProvider({
      status: 'ready_to_schedule',
      latestQuote: { ...accepted, payoutAmount: 50_000 },
      quotes: [accepted],
      replacementPayoutPending: true,
    }),
    actor: pricing,
    expects: ['quote.setPayout'],
  },
  {
    stage: 'scheduling',
    next: 'staff:schedule.manage',
    snap: withProvider({
      status: 'ready_to_schedule',
      latestQuote: accepted,
      quotes: [accepted],
    }),
    actor: ops,
    expects: ['schedule.propose'],
  },
  {
    stage: 'schedule_proposed',
    next: 'customer',
    snap: withProvider({
      status: 'ready_to_schedule',
      currentSchedule: schedule('proposed'),
    }),
    actor: customer(),
    expects: ['schedule.respond'],
  },
  {
    stage: 'schedule_proposed',
    next: 'customer',
    snap: withProvider({
      status: 'ready_to_schedule',
      currentSchedule: schedule('proposed'),
    }),
    actor: provider(),
    expects: ['schedule.respond'],
  },
  {
    stage: 'schedule_changes',
    next: 'staff:schedule.manage',
    snap: withProvider({
      status: 'ready_to_schedule',
      currentSchedule: schedule('changes_requested'),
    }),
    actor: ops,
    expects: ['schedule.propose'],
  },
  {
    stage: 'scheduled',
    next: 'provider',
    snap: withProvider({
      status: 'scheduled',
      currentSchedule: schedule('confirmed', {
        startAt: new Date(NOW.getTime() + HOUR),
        endAt: new Date(NOW.getTime() + 3 * HOUR),
      }),
    }),
    actor: provider(),
    expects: ['progress.add', 'schedule.requestChange'],
  },
  {
    stage: 'reschedule',
    next: 'staff:schedule.manage',
    snap: withProvider({
      status: 'scheduled',
      currentSchedule: schedule('confirmed', {
        changeRequests: [{ handledAt: null }],
      }),
    }),
    actor: ops,
    expects: ['schedule.propose'],
  },
  {
    stage: 'in_progress',
    next: 'provider',
    snap: withProvider({ status: 'in_progress' }),
    actor: provider(),
    expects: ['progress.add'],
  },
  {
    stage: 'rework',
    next: 'provider',
    snap: withProvider({
      status: 'in_progress',
      openIssues: [{ status: 'rework' }],
    }),
    actor: provider(),
    expects: ['progress.add'],
  },
  {
    stage: 'blocked_provider',
    next: 'staff:progress.review',
    snap: withProvider({
      status: 'blocked',
      latestQuote: accepted,
      quotes: [accepted],
    }),
    actor: ops,
    expects: ['progress.addOnBehalf', 'assignment.replace'],
  },
  {
    stage: 'on_hold',
    next: 'staff:dispatch.manage',
    snap: withProvider({ status: 'blocked', hold: { kind: 'staff' } }),
    actor: staff('dispatch.manage'),
    expects: ['request.releaseHold'],
  },
  {
    stage: 'issue_open',
    next: 'staff:issue.resolve',
    snap: withProvider({ status: 'blocked', openIssues: [{ status: 'open' }] }),
    actor: ops,
    expects: ['issue.accept', 'issue.resolve', 'issue.escalate'],
  },
  {
    stage: 'dispute',
    next: 'staff:super_admin',
    snap: withProvider({
      status: 'blocked',
      openIssues: [{ status: 'disputed' }],
    }),
    actor: superAdmin,
    expects: ['issue.resolve'],
  },
  {
    stage: 'awaiting_customer_confirmation',
    next: 'customer',
    snap: withProvider({ status: 'completion_pending' }),
    actor: customer(),
    expects: ['completion.respond'],
  },
  {
    stage: 'defects_window',
    next: 'none',
    snap: withProvider({
      status: 'acknowledged',
      defectsWindowEndsAt: new Date(NOW.getTime() + 24 * HOUR),
    }),
    actor: customer(),
    expects: ['issue.raise'],
  },
  {
    stage: 'ready_to_close',
    next: 'staff:request.close',
    snap: withProvider({
      status: 'acknowledged',
      defectsWindowEndsAt: new Date(NOW.getTime() - HOUR),
    }),
    actor: ops,
    expects: ['request.close'],
  },
];

describe('allowedActions follows the "Next actor" column of 04 §5.3', () => {
  it.each(rows.map((row) => [row.stage, row.next, row] as const))(
    '%s (next: %s)',
    (stage, next, row) => {
      expect(deriveStage(row.snap, NOW)).toBe(stage);
      expect(nextActor(row.snap, stage, NOW)).toBe(next);
      const actions = actionsFor(row.snap, row.actor);
      for (const action of row.expects) expect(actions).toContain(action);
    },
  );

  it('gives a provider the costing action and Pricing the quote actions during pricing', () => {
    const snap = withProvider({ status: 'matched' });
    expect(actionsFor(snap, provider())).toContain('quote.contribute');
    expect(actionsFor(snap, pricing)).toEqual(
      expect.arrayContaining(['quote.save', 'quote.publish']),
    );
    expect(actionsFor(snap, pricing)).not.toContain('quote.approve');
  });

  it('keeps staff actions away from customers and providers', () => {
    const snap = withProvider({ status: 'matched' });
    for (const actor of [customer(), provider()])
      expect(actionsFor(snap, actor)).not.toEqual(
        expect.arrayContaining(['quote.publish']),
      );
    expect(actionsFor(snap, customer())).not.toContain('assignment.respond');
  });

  it('offers escalation to staff holding request.escalate', () => {
    const snap = withProvider({ status: 'in_progress' });
    expect(actionsFor(snap, ops)).toContain('request.escalate');
    expect(actionsFor(snap, staff('request.close'))).not.toContain(
      'request.escalate',
    );
    expect(actionsFor(snap, customer())).not.toContain('request.escalate');
  });

  it('offers nothing that changes work on a closed request', () => {
    const snap = withProvider({ status: 'closed' });
    const actions = actionsFor(snap, superAdmin);
    for (const action of [
      'assignment.auto',
      'assignment.replace',
      'quote.save',
      'schedule.propose',
      'progress.addOnBehalf',
      'request.hold',
      'issue.accept',
      'request.close',
      'request.escalate',
    ])
      expect(actions).not.toContain(action);
  });
});
