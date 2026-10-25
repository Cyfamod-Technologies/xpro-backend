import { countCommittedJobs } from './committed-jobs';

const job = (
  requestId: string,
  status: string,
  requestStatus = 'under_review',
) => ({ requestId, status, requestStatus });

describe('countCommittedJobs (04 §6.5 Q-def-10)', () => {
  it('counts offered and pending_approval assignments whatever the request status', () => {
    expect(
      countCommittedJobs(
        [job('r1', 'offered'), job('r2', 'pending_approval', 'under_review')],
        'current',
      ),
    ).toBe(2);
  });

  it.each([
    'ready_to_schedule',
    'scheduled',
    'in_progress',
    'blocked',
    'completion_pending',
  ])('counts an accepted assignment on a %s request', (requestStatus) => {
    expect(
      countCommittedJobs([job('r1', 'accepted', requestStatus)], 'x'),
    ).toBe(1);
  });

  it.each(['matched', 'quoted', 'awaiting_payment', 'acknowledged'])(
    'does not count an accepted assignment on a %s request',
    (requestStatus) => {
      expect(
        countCommittedJobs([job('r1', 'accepted', requestStatus)], 'x'),
      ).toBe(0);
    },
  );

  it.each([
    'declined',
    'expired',
    'not_confirmed',
    'withdrawn',
    'replaced',
    'completed',
  ])('does not count an assignment that is %s', (status) => {
    expect(countCommittedJobs([job('r1', status, 'scheduled')], 'x')).toBe(0);
  });

  it('ignores the request being dispatched', () => {
    expect(
      countCommittedJobs(
        [job('current', 'offered'), job('r2', 'offered')],
        'current',
      ),
    ).toBe(1);
  });

  it('counts a request once even with two assignments on it', () => {
    expect(
      countCommittedJobs(
        [job('r1', 'accepted', 'scheduled'), job('r1', 'offered')],
        'x',
      ),
    ).toBe(1);
  });

  it('is zero for no assignments', () => {
    expect(countCommittedJobs([], 'x')).toBe(0);
  });
});
