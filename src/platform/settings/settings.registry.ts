export type RiskClass = 'high' | 'operational';
export type SettingsValue =
  string | number | boolean | null | string[] | Record<string, unknown>;

export type SettingDefinition = {
  defaultValue: SettingsValue;
  riskClass: RiskClass;
  label: string;
  validate(value: unknown): string | null;
};

// new message: not in spec
const UNSPECIFIED_SETTING_MESSAGE = 'Enter a valid value for this setting.';

const integerRange =
  (min: number, max: number, message: string) =>
  (value: unknown): string | null =>
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max
      ? null
      : message;
const textRange =
  (min: number, max: number, message: string) =>
  (value: unknown): string | null =>
    typeof value === 'string' && value.length >= min && value.length <= max
      ? null
      : message;
const positiveNullable =
  (message: string) =>
  (value: unknown): string | null =>
    value === null || (Number.isSafeInteger(value) && Number(value) > 0)
      ? null
      : message;
const booleanValue = (value: unknown): string | null =>
  typeof value === 'boolean' ? null : UNSPECIFIED_SETTING_MESSAGE;
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const validWeights = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return UNSPECIFIED_SETTING_MESSAGE;
  const weights = value as Record<string, unknown>;
  const keys = ['area', 'capacity', 'fairness', 'experience', 'reliability'];
  if (
    Object.keys(weights).length !== keys.length ||
    !keys.every((key) => nonNegativeInteger(weights[key]))
  )
    return UNSPECIFIED_SETTING_MESSAGE;
  return keys.reduce((sum, key) => sum + Number(weights[key]), 0) > 0
    ? null
    : UNSPECIFIED_SETTING_MESSAGE;
};
const validModeByService = (value: unknown): string | null => {
  const lines = [
    'Design',
    'Construction',
    'Hire',
    'Procurement',
    'Facility management',
    'Waste management',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== lines.length ||
    !lines.every((line) =>
      ['auto', 'manual'].includes(
        String((value as Record<string, unknown>)[line]),
      ),
    )
  )
    return UNSPECIFIED_SETTING_MESSAGE;
  return null;
};
const deadlineDefaults: Record<string, number> = {
  unclaimed: 120,
  intake: 240,
  clarification_overdue: 480,
  needs_assignment: 120,
  assignment: 240,
  no_show: 120,
  quote_build: 480,
  quote_approval: 480,
  quote_followup: 480,
  schedule_needed: 480,
  schedule_change: 240,
  progress: 480,
  blocker: 60,
  completion: 240,
  completion_issue: 480,
  cancellation: 240,
  ready_to_close: 480,
  escalation: 120,
  provider: 1200,
  provider_changes: 1200,
  provider_reliability: 1200,
  bank: 600,
  offline_payment: 600,
  refund: 600,
  payout: 1200,
  payout_second: 480,
  compensation: 1200,
};
const validDeadlines = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'Enter a deadline between 15 minutes and 5 working days.';
  const deadlines = value as Record<string, unknown>;
  if (
    Object.keys(deadlines).length !== Object.keys(deadlineDefaults).length ||
    !Object.keys(deadlineDefaults).every(
      (key) =>
        Number.isInteger(deadlines[key]) &&
        Number(deadlines[key]) >= 15 &&
        Number(deadlines[key]) <= 3000,
    )
  )
    return 'Enter a deadline between 15 minutes and 5 working days.';
  return null;
};
const validHolidays = (value: unknown): string | null => {
  if (!Array.isArray(value) || !value.every((date) => typeof date === 'string'))
    return UNSPECIFIED_SETTING_MESSAGE;
  const year = new Date(Date.now() + 60 * 60 * 1000).getUTCFullYear();
  const dates = value;
  if (
    dates.some((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
      const parsed = new Date(`${date}T00:00:00.000Z`);
      return (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date ||
        parsed.getUTCFullYear() < year
      );
    })
  )
    return UNSPECIFIED_SETTING_MESSAGE;
  return null;
};

const operational = (
  defaultValue: SettingsValue,
  label: string,
  validate: SettingDefinition['validate'],
): SettingDefinition => ({
  defaultValue,
  label,
  validate,
  riskClass: 'operational',
});
const highRisk = (
  defaultValue: SettingsValue,
  label: string,
  validate: SettingDefinition['validate'],
): SettingDefinition => ({ defaultValue, label, validate, riskClass: 'high' });

export const SETTINGS_REGISTRY = {
  'assignment.modeByService': operational(
    {
      Design: 'auto',
      Construction: 'auto',
      Hire: 'auto',
      Procurement: 'auto',
      'Facility management': 'auto',
      'Waste management': 'auto',
    },
    'Assignment mode by service',
    validModeByService,
  ),
  'assignment.offerExpiryHours': operational(
    24,
    'Offer expiry',
    integerRange(1, 168, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'assignment.offerMinWorkingHours': operational(
    4,
    'Minimum offer working time',
    integerRange(0, 24, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'assignment.maxAutoAttempts': operational(
    3,
    'Maximum assignment attempts',
    integerRange(1, 10, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'assignment.weights': operational(
    { area: 25, capacity: 20, fairness: 15, experience: 5, reliability: 0 },
    'Assignment weights',
    validWeights,
  ),
  'assignment.requireVerifiedBank': highRisk(
    true,
    'Require verified bank details',
    booleanValue,
  ),
  'assignment.rankingRunMaxAgeMinutes': operational(
    15,
    'Ranking run maximum age',
    integerRange(5, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'quote.approvalThreshold': highRisk(
    null,
    'Quote approval threshold',
    positiveNullable(
      'Enter a positive approval threshold, or turn the approval rule off.',
    ),
  ),
  'quote.validityDays': operational(
    14,
    'Quote validity',
    integerRange(1, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'payment.dueDays': operational(
    7,
    'Payment due period',
    integerRange(1, 30, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'clarification.reminderHours': operational(
    48,
    'Clarification reminder',
    integerRange(1, 720, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'clarification.escalateDays': operational(
    5,
    'Clarification escalation',
    integerRange(1, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'clarification.autoCancelDays': operational(
    14,
    'Clarification auto-cancel',
    integerRange(1, 90, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'pricing.stallReminderHours': operational(
    24,
    'Pricing stall reminder',
    integerRange(1, 720, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'pricing.stallEscalateHours': operational(
    48,
    'Pricing stall escalation',
    integerRange(1, 720, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'schedule.responseReminderHours': operational(
    24,
    'Schedule response reminder',
    integerRange(1, 720, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'schedule.responseEscalateHours': operational(
    48,
    'Schedule response escalation',
    integerRange(1, 720, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'execution.earlyStartMinutes': operational(
    120,
    'Early start window',
    integerRange(0, 1440, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'execution.noShowGraceWorkingHours': operational(
    2,
    'No-show grace period',
    integerRange(1, 8, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'execution.staleUpdateDays': operational(
    3,
    'Stale update reminder',
    integerRange(1, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'execution.escalateDays': operational(
    5,
    'Stale update escalation',
    integerRange(1, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'execution.blockedEscalateDays': operational(
    2,
    'Blocked update escalation',
    integerRange(1, 60, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'completion.windowHours': highRisk(
    72,
    'Completion confirmation window',
    integerRange(24, 336, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'completion.defectsWindowDays': highRisk(
    7,
    'Defects window',
    integerRange(0, 30, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'completion.maxIssueCycles': operational(
    2,
    'Maximum issue cycles',
    integerRange(1, 5, UNSPECIFIED_SETTING_MESSAGE),
  ),
  'calendar.holidays': operational(
    [],
    'Business calendar holidays',
    validHolidays,
  ),
  'approvals.deadlines': operational(
    deadlineDefaults,
    'Approval deadlines',
    validDeadlines,
  ),
  'payment.offlineInstructions': highRisk(
    '',
    'Offline payment instructions',
    textRange(20, 2000, 'Enter the bank details customers should pay into.'),
  ),
  'payout.secondApprovalThreshold': highRisk(
    null,
    'Payout second approval threshold',
    positiveNullable(
      'Enter a positive payout threshold, or turn the second approval off.',
    ),
  ),
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

export function getSettingDefinition(
  key: string,
): SettingDefinition | undefined {
  return SETTINGS_REGISTRY[key as SettingKey];
}
