import {
  appendChangeRequest,
  hasOpenChangeRequest,
  markChangeRequestsHandled,
  readChangeRequests,
} from './change-requests';

const NOW = new Date('2026-10-25T10:00:00.000Z');

describe('schedule change requests (plan §D.2 shape)', () => {
  it('appends { by, note, at, handledAt }', () => {
    expect(
      appendChangeRequest([], { by: 'customer', note: 'Move it', at: NOW }),
    ).toEqual([
      {
        by: 'customer',
        note: 'Move it',
        at: '2026-10-25T10:00:00.000Z',
        handledAt: null,
      },
    ]);
  });

  it('reads the old { party, createdAt, urgent } rows, a missing handledAt being open', () => {
    const old = [
      {
        party: 'provider',
        note: 'Sick',
        createdAt: '2026-10-20T08:00:00.000Z',
        urgent: true,
      },
    ];
    expect(readChangeRequests(old)).toEqual([
      {
        by: 'provider',
        note: 'Sick',
        at: '2026-10-20T08:00:00.000Z',
        handledAt: null,
      },
    ]);
    expect(hasOpenChangeRequest(old, 'provider')).toBe(true);
    expect(hasOpenChangeRequest(old, 'customer')).toBe(false);
  });

  it('rewrites old rows in the new shape when appending', () => {
    const [first, second] = appendChangeRequest(
      [{ party: 'provider', note: 'Sick', createdAt: 'then', handledAt: null }],
      { by: 'customer', note: 'Away', at: NOW },
    );
    expect(first).toEqual({
      by: 'provider',
      note: 'Sick',
      at: 'then',
      handledAt: null,
    });
    expect(second.by).toBe('customer');
  });

  it('ignores entries that are not objects or have no known party', () => {
    expect(readChangeRequests('x')).toEqual([]);
    expect(readChangeRequests([null, 3, { by: 'staff' }])).toEqual([]);
  });

  it('marks every open request handled and keeps earlier handled times', () => {
    const marked = markChangeRequestsHandled(
      [
        { by: 'customer', note: 'a', at: 't1', handledAt: null },
        { by: 'provider', note: 'b', at: 't2', handledAt: 'earlier' },
        { party: 'provider', note: 'c', createdAt: 't3' },
      ],
      NOW,
    );
    expect(marked.map((item) => item.handledAt)).toEqual([
      '2026-10-25T10:00:00.000Z',
      'earlier',
      '2026-10-25T10:00:00.000Z',
    ]);
    expect(hasOpenChangeRequest(marked, 'customer')).toBe(false);
    expect(hasOpenChangeRequest(marked, 'provider')).toBe(false);
  });

  it('lets a party ask again once its earlier request was handled', () => {
    const handled = markChangeRequestsHandled(
      appendChangeRequest([], { by: 'customer', note: 'a', at: NOW }),
      NOW,
    );
    expect(hasOpenChangeRequest(handled, 'customer')).toBe(false);
  });
});
