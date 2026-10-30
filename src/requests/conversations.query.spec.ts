import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import type { StaffPermission } from '../staff/staff-permissions';
import {
  conversationRowsSql,
  conversationStatusCountsSql,
  decodeCursor,
  encodeCursor,
  escapeLike,
  previewText,
  readableChannels,
  requestNumberFromQuery,
  searchPattern,
} from './conversations.query';

function staffWith(
  permissions: StaffPermission[],
  status: 'active' | 'suspended' = 'active',
): ActorContext {
  return {
    userId: 'staff-1',
    kind: 'staff',
    displayName: 'Sam Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status,
      roles: [],
      permissions: new Set(permissions),
      canOwn: true,
      isSuperAdmin: false,
      permVersion: 1,
    },
  };
}

describe('readableChannels', () => {
  it('maps message permissions to channels in a fixed order', () => {
    expect(
      readableChannels(
        staffWith(['message.internal', 'message.customer', 'message.provider']),
      ),
    ).toEqual(['customer', 'provider', 'internal']);
    expect(
      readableChannels(staffWith(['message.provider', 'message.internal'])),
    ).toEqual(['provider', 'internal']);
    expect(readableChannels(staffWith(['message.customer']))).toEqual([
      'customer',
    ]);
    expect(readableChannels(staffWith(['view.pricing']))).toEqual([]);
  });

  it('gives nothing to non-staff and to inactive staff', () => {
    expect(
      readableChannels({
        userId: 'c',
        kind: 'customer',
        displayName: 'Casey',
        platformRoles: ['customer'],
        accountActive: true,
      }),
    ).toEqual([]);
    expect(
      readableChannels(staffWith(['message.customer'], 'suspended')),
    ).toEqual([]);
  });
});

describe('conversation cursor', () => {
  const at = new Date('2026-10-30T09:15:30.123Z');

  it('round-trips the last message time and request number', () => {
    const decoded = decodeCursor(encodeCursor({ at, number: 42 }));
    expect(decoded.at.toISOString()).toBe(at.toISOString());
    expect(decoded.number).toBe(42);
  });

  it('is opaque url-safe text', () => {
    expect(encodeCursor({ at, number: 42 })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 text', '***'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['json null', Buffer.from('null').toString('base64url')],
    [
      'a missing number',
      Buffer.from('{"t":"2026-10-30T09:15:30.123Z"}').toString('base64url'),
    ],
    [
      'a non-date time',
      Buffer.from('{"t":"yesterday","n":4}').toString('base64url'),
    ],
    [
      'a loose date format',
      Buffer.from('{"t":"2026-10-30","n":4}').toString('base64url'),
    ],
    [
      'a zero number',
      Buffer.from('{"t":"2026-10-30T09:15:30.123Z","n":0}').toString(
        'base64url',
      ),
    ],
    [
      'a fractional number',
      Buffer.from('{"t":"2026-10-30T09:15:30.123Z","n":1.5}').toString(
        'base64url',
      ),
    ],
    [
      'a string number',
      Buffer.from('{"t":"2026-10-30T09:15:30.123Z","n":"4"}').toString(
        'base64url',
      ),
    ],
  ])('rejects %s with a 422 VALIDATION_ERROR', (_name, value) => {
    expect.assertions(3);
    try {
      decodeCursor(value);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(422);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('search escaping', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
    expect(searchPattern('a_b')).toBe('%a\\_b%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Roof replacement')).toBe('Roof replacement');
  });

  it('reads request numbers from ids and digits', () => {
    expect(requestNumberFromQuery('42')).toBe(42);
    expect(requestNumberFromQuery('0042')).toBe(42);
    expect(requestNumberFromQuery('XPR-00042')).toBe(42);
    expect(requestNumberFromQuery('xpr-42')).toBe(42);
    expect(requestNumberFromQuery('0')).toBeNull();
    expect(requestNumberFromQuery('roof 42')).toBeNull();
    expect(requestNumberFromQuery('1234567890')).toBeNull();
  });
});

describe('previewText', () => {
  it('returns short text unchanged', () => {
    expect(previewText('Thursday would be ideal.')).toBe(
      'Thursday would be ideal.',
    );
  });

  it('collapses whitespace and line breaks into one line', () => {
    expect(previewText('  Line one\n\nline   two\t')).toBe('Line one line two');
  });

  it('keeps text of exactly the limit', () => {
    const exact = 'a'.repeat(140);
    expect(previewText(exact)).toBe(exact);
  });

  it('cuts at a word boundary with an ellipsis', () => {
    const text = `${'word '.repeat(40)}end`;
    const preview = previewText(text);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(141);
    expect(preview.slice(0, -1).endsWith(' ')).toBe(false);
    expect(
      preview
        .slice(0, -1)
        .split(' ')
        .every((w) => w === 'word'),
    ).toBe(true);
  });

  it('hard-cuts a long unbroken string', () => {
    expect(previewText('x'.repeat(300))).toBe(`${'x'.repeat(140)}…`);
  });

  it('does not split an emoji', () => {
    const preview = previewText('😀'.repeat(200));
    expect([...preview]).toHaveLength(141);
    expect(preview).toBe(`${'😀'.repeat(140)}…`);
  });
});

describe('conversation SQL', () => {
  const all = ['customer', 'provider', 'internal'] as const;

  it('limits the provider branch to the current assignment thread', () => {
    const { sql } = conversationRowsSql({ channels: all, take: 26 });
    expect(sql).toContain(
      "m.channel = 'provider' AND m.provider_id = e.current_provider_id",
    );
    expect(sql).toContain('DISTINCT ON (request_id)');
  });

  it('includes only the permitted channels', () => {
    const { sql } = conversationRowsSql({
      channels: ['provider', 'internal'],
      take: 26,
    });
    expect(sql).not.toContain("m.channel = 'customer'");
    expect(sql).toContain("m.channel = 'internal'");
  });

  it('binds user input as parameters and never inlines it', () => {
    const hostile = "x'; DROP TABLE service_requests; --";
    const statement = conversationRowsSql({
      channels: all,
      q: hostile,
      statuses: ["in_progress'; --"],
      cursor: { at: new Date('2026-10-30T09:15:30.123Z'), number: 7 },
      take: 26,
    });
    expect(statement.sql).not.toContain('DROP TABLE');
    expect(statement.sql).not.toContain("in_progress'");
    expect(statement.values).toContain(searchPattern(hostile));
    expect(statement.values).toContainEqual(["in_progress'; --"]);
    expect(statement.values).toContain(26);
    expect(statement.values).toContain(7);
  });

  it('adds no search joins without a query', () => {
    expect(conversationRowsSql({ channels: all, take: 26 }).sql).not.toContain(
      'ILIKE',
    );
    const searched = conversationStatusCountsSql({ channels: all, q: 'roof' });
    expect(searched.sql).toContain('ILIKE ?');
    expect(searched.sql).toContain('GROUP BY e.status');
  });

  it('matches the request number for id-like text', () => {
    const { sql, values } = conversationRowsSql({
      channels: all,
      q: 'XPR-00042',
      take: 26,
    });
    expect(sql).toContain('r.number =');
    expect(values).toContain(42);
  });

  it('keeps the status counts independent of any status filter', () => {
    const { sql, values } = conversationStatusCountsSql({ channels: all });
    // The only parameter is the list of current assignment statuses.
    expect(values).toEqual([
      ['offered', 'pending_approval', 'accepted', 'completed'],
    ]);
    expect(sql).not.toMatch(/LIMIT (?!1\b)/);
  });
});
