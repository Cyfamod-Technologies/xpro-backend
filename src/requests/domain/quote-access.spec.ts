import { confirmedAssignmentIds } from './quote-access';

const row = (
  id: string,
  providerUserId: string,
  status: string,
  reviewedAt: Date | null = null,
) => ({ id, providerUserId, status, reviewedAt });

describe('confirmedAssignmentIds (B-01, E-26)', () => {
  it('returns the current and replaced assignments the provider held', () => {
    const rows = [
      row('a-1', 'provider-1', 'replaced'),
      row('a-2', 'provider-1', 'accepted'),
      row('a-3', 'provider-2', 'accepted'),
    ];
    expect(confirmedAssignmentIds(rows, 'provider-1')).toEqual(['a-1', 'a-2']);
    expect(confirmedAssignmentIds(rows, 'provider-2')).toEqual(['a-3']);
  });

  it('includes a completed assignment and a withdrawal after staff confirmed it', () => {
    const rows = [
      row('a-1', 'provider-1', 'completed'),
      row('a-2', 'provider-1', 'withdrawn', new Date('2026-10-20')),
    ];
    expect(confirmedAssignmentIds(rows, 'provider-1')).toEqual(['a-1', 'a-2']);
  });

  it('gives a stranger and an unconfirmed provider nothing', () => {
    const rows = [
      row('a-1', 'provider-1', 'offered'),
      row('a-2', 'provider-1', 'pending_approval'),
      row('a-3', 'provider-1', 'declined'),
      row('a-4', 'provider-1', 'expired'),
      row('a-5', 'provider-1', 'not_confirmed'),
      row('a-6', 'provider-1', 'withdrawn'),
    ];
    expect(confirmedAssignmentIds(rows, 'provider-1')).toEqual([]);
    expect(confirmedAssignmentIds(rows, 'stranger')).toEqual([]);
    expect(confirmedAssignmentIds([], 'provider-1')).toEqual([]);
  });
});
