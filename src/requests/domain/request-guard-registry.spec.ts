import { DISPATCH_GUARDS } from './dispatch-guards';
import { ESCALATION_GUARDS } from './escalation-guards';
import { INTAKE_GUARDS } from './intake-guards';
import { LIFECYCLE_GUARDS } from './lifecycle-guards';
import { MESSAGE_GUARDS } from './message-guards';
import { OWNERSHIP_GUARDS } from './ownership-guards';
import { PAYMENT_GUARDS } from './payment-guards';
import { PRICING_GUARDS } from './pricing-guards';
import { REQUEST_GUARDS } from './request-guard-registry';
import { UPDATE_GUARDS } from './request-update-guards';

/** Every command key in the 04 §2.1 "Command → permission" table, in table order. */
const SPEC_04_SECTION_2_1_COMMANDS = [
  'request.create',
  'request.update',
  'request.review',
  'request.clarify',
  'request.reject',
  'request.cancel',
  'cancellation.request',
  'cancellation.withdraw',
  'cancellation.decide',
  'request.hold',
  'request.releaseHold',
  'dispatch.setMode',
  'assignment.auto',
  'assignment.offer',
  'assignment.respond',
  'assignment.review',
  'assignment.withdraw',
  'assignment.replace',
  'assignment.expire',
  'request.shareDetails',
  'quote.contribute',
  'quote.save',
  'quote.publish',
  'quote.setPayout',
  'quote.approve',
  'quote.return',
  'quote.respond',
  'schedule.propose',
  'schedule.respond',
  'schedule.requestChange',
  'progress.add',
  'progress.addOnBehalf',
  'progress.review',
  'noshow.record',
  'noshow.confirm',
  'noshow.dismiss',
  'noshow.correct',
  'completion.respond',
  'completion.confirmOnBehalf',
  'issue.raise',
  'issue.accept',
  'issue.resolve',
  'issue.escalate',
  'request.close',
  'message.send',
] as const;

/** Commands the plan names outside the 04 §2.1 table: 02 §6.5 ownership, 05 payments, escalations, and the dispatch ranking and cascade. */
const OTHER_COMMANDS = [
  'request.claim',
  'request.release',
  'request.handoff',
  'request.reassign',
  'payment.initiate',
  'payment.recordOffline',
  'payment.reconcile',
  'payment.rejectOffline',
  'request.escalate',
  'request.escalation.resolve',
  'dispatch.runs',
  'dispatch.cascade',
];

/** Commands that never run against an existing request in a user's hands, so they have no guard. */
const NO_GUARD = new Map([
  [
    'request.create',
    'runs before the request exists (RequestCommandRunner.create)',
  ],
  [
    'assignment.expire',
    'timer T1 only; the demo staff button is not built (dev timers endpoint)',
  ],
]);

describe('REQUEST_GUARDS registry', () => {
  it.each(
    SPEC_04_SECTION_2_1_COMMANDS.filter((command) => !NO_GUARD.has(command)),
  )('has a guard for the 04 §2.1 command %s', (command) => {
    expect(REQUEST_GUARDS[command]).toEqual(expect.any(Function));
  });

  it.each(OTHER_COMMANDS)('has a guard for %s', (command) => {
    expect(REQUEST_GUARDS[command]).toEqual(expect.any(Function));
  });

  it('documents every §2.1 command it leaves out', () => {
    for (const [command] of NO_GUARD) {
      expect(SPEC_04_SECTION_2_1_COMMANDS).toContain(command);
      expect(REQUEST_GUARDS[command]).toBeUndefined();
    }
  });

  it('has no key that is not a command', () => {
    expect(REQUEST_GUARDS['dispatch.manage']).toBeUndefined();
    const known = new Set<string>([
      ...SPEC_04_SECTION_2_1_COMMANDS,
      ...OTHER_COMMANDS,
    ]);
    expect(
      Object.keys(REQUEST_GUARDS).filter((key) => !known.has(key)),
    ).toEqual([]);
  });

  it('has one guard per command: no key appears in two groups', () => {
    const groups = [
      INTAKE_GUARDS,
      MESSAGE_GUARDS,
      UPDATE_GUARDS,
      OWNERSHIP_GUARDS,
      DISPATCH_GUARDS,
      LIFECYCLE_GUARDS,
      PRICING_GUARDS,
      PAYMENT_GUARDS,
      ESCALATION_GUARDS,
    ];
    const keys = groups.flatMap((group) => Object.keys(group));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual(
      [],
    );
    expect(Object.keys(REQUEST_GUARDS)).toHaveLength(keys.length);
  });
});
