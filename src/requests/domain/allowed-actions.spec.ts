import { allowedActions } from './allowed-actions';
import type { RequestSnapshot } from './snapshot';

const snap = { status: 'submitted' } as RequestSnapshot;

describe('allowedActions', () => {
  it('returns no actions while the initial guard registry is empty', () => {
    expect(allowedActions(snap, { kind: 'customer' }, new Date(), {})).toEqual([]);
  });

  it('includes only actions whose registered guards pass', () => {
    expect(allowedActions(snap, { kind: 'customer' }, new Date(), {}, {
      'request.read': () => ({ ok: true }),
      'request.cancel': () => ({ ok: false, status: 409, code: 'STATE_CONFLICT', message: 'closed' }),
    })).toEqual(['request.read']);
  });
});
