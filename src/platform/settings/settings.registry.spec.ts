import { getSettingDefinition, SETTINGS_REGISTRY } from './settings.registry';

describe('settings registry', () => {
  it('has a valid default for every registered setting', () => {
    for (const [key, definition] of Object.entries(SETTINGS_REGISTRY)) {
      if (key !== 'payment.offlineInstructions')
        expect(definition.validate(definition.defaultValue)).toBeNull();
      expect(definition.label.length).toBeGreaterThan(0);
      expect(['high', 'operational']).toContain(definition.riskClass);
      expect(getSettingDefinition(key)).toBe(definition);
    }
  });

  it('rejects values outside the numeric ranges', () => {
    const rangeCases: Array<[string, unknown]> = [
      ['assignment.offerExpiryHours', 0],
      ['assignment.offerMinWorkingHours', 25],
      ['assignment.maxAutoAttempts', 11],
      ['assignment.rankingRunMaxAgeMinutes', 4],
      ['quote.validityDays', 61],
      ['payment.dueDays', 0],
      ['clarification.reminderHours', 0],
      ['clarification.escalateDays', 0],
      ['clarification.autoCancelDays', 91],
      ['pricing.stallReminderHours', 0],
      ['pricing.stallEscalateHours', 721],
      ['schedule.responseReminderHours', 0],
      ['schedule.responseEscalateHours', 721],
      ['execution.earlyStartMinutes', 1441],
      ['execution.noShowGraceWorkingHours', 0],
      ['execution.staleUpdateDays', 0],
      ['execution.escalateDays', 61],
      ['execution.blockedEscalateDays', 0],
      ['completion.windowHours', 23],
      ['completion.defectsWindowDays', 31],
      ['completion.maxIssueCycles', 0],
      ['quote.approvalThreshold', 0],
      ['payout.secondApprovalThreshold', 0],
    ];
    for (const [key, value] of rangeCases) {
      expect(getSettingDefinition(key)?.validate(value)).toBeTruthy();
    }
  });

  it('validates assignment modes, weights, deadlines, holidays and offline instructions', () => {
    expect(
      getSettingDefinition('assignment.modeByService')?.validate({}),
    ).toBeTruthy();
    expect(
      getSettingDefinition('assignment.weights')?.validate({
        area: 0,
        capacity: 0,
        fairness: 0,
        experience: 0,
        reliability: 0,
      }),
    ).toBeTruthy();
    expect(
      getSettingDefinition('approvals.deadlines')?.validate({ intake: 30 }),
    ).toBeTruthy();
    expect(
      getSettingDefinition('calendar.holidays')?.validate(['2026-02-30']),
    ).toBeTruthy();
    expect(
      getSettingDefinition('payment.offlineInstructions')?.validate(''),
    ).toBe('Enter the bank details customers should pay into.');
    expect(
      getSettingDefinition('payment.offlineInstructions')?.validate(
        'x'.repeat(2001),
      ),
    ).toBeTruthy();
  });

  it('uses the WAT year when validating holiday dates', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T23:30:00Z'));
    try {
      const holidays = getSettingDefinition('calendar.holidays');
      expect(holidays?.validate(['2026-12-31'])).toBeTruthy();
      expect(holidays?.validate(['2027-01-01'])).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
