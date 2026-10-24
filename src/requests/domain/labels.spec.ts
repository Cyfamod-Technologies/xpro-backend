import { deriveOverlays, statusLabel, STAGE_LABELS } from './labels';
import type { RequestSnapshot } from './snapshot';
import type { RequestStage } from './stage';

const stages = Object.keys(STAGE_LABELS) as RequestStage[];

describe('stage labels (§5.3)', () => {
  it.each(stages)('defines labels for all roles at %s', (stage) => {
    for (const role of ['customer', 'provider', 'staff'] as const) {
      expect(statusLabel(stage, role)).toBe(STAGE_LABELS[stage][role]);
    }
  });

  it('keeps the provider label hidden before an offer exists', () => {
    expect(statusLabel('intake_review', 'provider')).toBeNull();
    expect(statusLabel('dispatching', 'provider')).toBeNull();
  });

  it('interpolates offer, quote, date and hold values', () => {
    expect(statusLabel('offer_out', 'provider', { time: 'tomorrow' })).toBe(
      'Offer received — respond by tomorrow',
    );
    expect(statusLabel('offer_out', 'staff', { n: 2, max: 3 })).toBe(
      'Offer out (attempt 2 of 3)',
    );
    expect(statusLabel('quote_revision', 'staff', { n: 4 })).toBe(
      'Revise quote v4',
    );
    expect(statusLabel('defects_window', 'customer', { date: '31 Oct' })).toBe(
      'Completed — report a problem by 31 Oct',
    );
    expect(statusLabel('on_hold', 'staff', { kind: 'staff' })).toBe(
      'On hold — staff',
    );
  });

  it('uses the costing and schedule response variants', () => {
    const snap = {
      currentSchedule: { customer: 'accepted', provider: 'pending' },
      providerCostingSubmitted: true,
    } as unknown as RequestSnapshot;
    expect(statusLabel('pricing', 'provider', {}, snap)).toBe(
      'Costing sent — XPro is preparing the quote',
    );
    expect(statusLabel('schedule_proposed', 'customer', {}, snap)).toBe(
      'Waiting for the provider to confirm',
    );
  });

  it('returns the cancellation, flag and suspended-party overlays without changing stage', () => {
    const snap = {
      pendingCancellation: true,
      flag: 'review',
      customerStanding: 'active',
      providerStanding: 'suspended',
    } as RequestSnapshot;
    expect(deriveOverlays(snap)).toEqual({
      cancellation: {
        customer: 'Cancellation requested — awaiting XPro',
        staff: 'Cancellation to decide',
      },
      flag: 'review',
      suspendedParties: ['Provider suspended'],
    });
  });

  it('shows both suspended-party overlays when both accounts are suspended', () => {
    expect(
      deriveOverlays({
        customerStanding: 'suspended',
        providerStanding: 'suspended',
        pendingCancellation: false,
      } as RequestSnapshot).suspendedParties,
    ).toEqual(['Customer suspended', 'Provider suspended']);
  });
});
