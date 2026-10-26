import {
  assessManualOffer,
  assessReviewRecheck,
  noLongerAvailableMessage,
} from './assignment-rules';
import type { EligibilityFailure, EligibilityRule } from './eligibility';

const f = (
  rule: EligibilityRule,
  reason = `${rule} reason`,
): EligibilityFailure => ({
  rule,
  reason,
});

describe('assessManualOffer (04 §6.6 manual offer table)', () => {
  const offer = (
    failures: EligibilityFailure[],
    overrides: {
      providerId?: string;
      topSuggestionId?: string | null;
      overrideNote?: string;
    } = {},
  ) =>
    assessManualOffer({
      failures,
      providerId: 'p1',
      topSuggestionId: 'p1',
      ...overrides,
    });

  it('accepts the top suggestion with no failing rule and no note', () => {
    expect(offer([])).toEqual({
      ok: true,
      overriddenRules: [],
      noteRequired: false,
    });
  });

  it.each(['verification', 'standing', 'service', 'available'] as const)(
    'refuses a provider failing %s with the approved-provider message, even with a note',
    (rule) => {
      expect(offer([f(rule)], { overrideNote: 'Because.' })).toEqual({
        ok: false,
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'Choose an approved, available provider for this service.',
      });
    },
  );

  it('refuses the request owner with the own-request message', () => {
    expect(offer([f('conflict')], { overrideNote: 'Because.' })).toMatchObject({
      ok: false,
      message: "A provider can't be offered their own request.",
    });
  });

  it('puts the approved-provider message before the own-request message', () => {
    expect(offer([f('conflict'), f('service')])).toMatchObject({
      message: 'Choose an approved, available provider for this service.',
    });
  });

  it.each(['area', 'day', 'skill', 'capacity', 'previous', 'bank'] as const)(
    'needs a note when the provider fails %s',
    (rule) => {
      expect(offer([f(rule)])).toMatchObject({
        ok: false,
        status: 422,
        message:
          'Add a note explaining why you chose this provider over the suggestion.',
      });
      expect(offer([f(rule)], { overrideNote: '  ' })).toMatchObject({
        ok: false,
      });
      expect(
        offer([f(rule)], { overrideNote: 'Known to the customer.' }),
      ).toEqual({
        ok: true,
        overriddenRules: [rule],
        noteRequired: true,
      });
    },
  );

  it('needs a note when the provider is not the top suggestion', () => {
    expect(offer([], { topSuggestionId: 'someone-else' })).toMatchObject({
      ok: false,
      message:
        'Add a note explaining why you chose this provider over the suggestion.',
    });
    expect(
      offer([], { topSuggestionId: null, overrideNote: 'No ranked provider.' }),
    ).toEqual({ ok: true, overriddenRules: [], noteRequired: true });
  });

  it('records every failing rule as overridden, not only the first', () => {
    expect(
      offer([f('area'), f('bank')], { overrideNote: 'Approved by Ops.' }),
    ).toEqual({
      ok: true,
      overriddenRules: ['area', 'bank'],
      noteRequired: true,
    });
  });
});

describe('noLongerAvailableMessage (04 §6.6 capacity locking)', () => {
  it('names the provider and the failing reason', () => {
    expect(
      noLongerAvailableMessage('Acme Ltd', 'At capacity (3 of 3 jobs)'),
    ).toBe(
      'Acme Ltd can no longer take this job (At capacity (3 of 3 jobs)). Refresh the ranked list.',
    );
  });
});

describe('assessReviewRecheck (04 §6.9 re-check table)', () => {
  const recheck = (failures: EligibilityFailure[], overrideNote?: string) =>
    assessReviewRecheck({ providerName: 'Acme Ltd', failures, overrideNote });

  it('passes a provider that still qualifies', () => {
    expect(recheck([])).toEqual({
      ok: true,
      overriddenRules: [],
      overridden: false,
    });
  });

  it.each(['verification', 'standing', 'conflict', 'service'] as const)(
    'refuses with 409 when the provider now fails %s, even with a note',
    (rule) => {
      expect(recheck([f(rule)], 'Please confirm.')).toEqual({
        ok: false,
        status: 409,
        code: 'STATE_CONFLICT',
        message:
          'Acme Ltd is no longer approved for this service. Reject the acceptance instead.',
      });
    },
  );

  it.each(['available', 'area', 'day', 'skill', 'bank'] as const)(
    'asks for a note with 422 when the provider now fails %s',
    (rule) => {
      expect(recheck([f(rule, 'Some reason')])).toEqual({
        ok: false,
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'Add a note to confirm this provider despite: Some reason.',
      });
      expect(recheck([f(rule)], 'Checked by phone.')).toEqual({
        ok: true,
        overriddenRules: [rule],
        overridden: true,
      });
    },
  );

  it('lists every reason that needs a note', () => {
    expect(
      recheck([
        f('available', 'Not accepting new jobs'),
        f('area', 'Doesn’t cover Wuse II'),
        f('bank', 'Bank details not verified'),
      ]),
    ).toMatchObject({
      message:
        'Add a note to confirm this provider despite: Not accepting new jobs; Doesn’t cover Wuse II; Bank details not verified.',
    });
  });

  it('does not re-check capacity or previous for the provider’s own offer', () => {
    expect(recheck([f('capacity'), f('previous')])).toEqual({
      ok: true,
      overriddenRules: [],
      overridden: false,
    });
  });

  it('refuses before it asks for a note when both kinds of rule fail', () => {
    expect(recheck([f('area'), f('service')])).toMatchObject({
      status: 409,
    });
  });
});
