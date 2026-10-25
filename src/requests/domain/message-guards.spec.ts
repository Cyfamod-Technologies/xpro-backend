import { canSendMessage } from './message-guards';
import type { ActorView, RequestSnapshot } from './snapshot';

const snap = (overrides: Partial<RequestSnapshot> = {}) =>
  ({
    status: 'under_review',
    ownerId: 'customer-1',
    currentProviderUserId: 'provider-1',
    accessibleProviderUserIds: ['provider-1'],
    ...overrides,
  }) as RequestSnapshot;
const now = new Date('2026-10-25T10:00:00.000Z');
const send = (
  actor: ActorView,
  input?: unknown,
  snapshot: RequestSnapshot = snap(),
) => canSendMessage(snapshot, actor, input, now, {});

describe('canSendMessage', () => {
  const dualRole: ActorView = {
    kind: 'provider',
    userId: 'customer-1',
    platformRoles: ['provider', 'customer'],
  };

  it('lets a provider who also holds the customer role write to their own customer channel (A-15)', () => {
    expect(send(dualRole, { channel: 'customer' })).toEqual({ ok: true });
    expect(send(dualRole)).toEqual({ ok: true });
  });

  it('does not give that account the provider or internal channels of a request they do not work', () => {
    expect(send(dualRole, { channel: 'provider' })).toMatchObject({
      ok: false,
      status: 403,
      message: 'Choose a conversation available to your account.',
    });
    expect(send(dualRole, { channel: 'internal' })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('keeps the current provider to the provider channel, including with the customer role', () => {
    const provider: ActorView = {
      kind: 'provider',
      userId: 'provider-1',
      platformRoles: ['provider', 'customer'],
    };
    expect(send(provider, { channel: 'provider' })).toEqual({ ok: true });
    expect(send(provider, { channel: 'customer' })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses every sender on a terminal request with a 409 STATE_CONFLICT (A-18)', () => {
    expect(
      send(dualRole, { channel: 'customer' }, snap({ status: 'closed' })),
    ).toEqual({
      ok: false,
      status: 409,
      code: 'STATE_CONFLICT',
      message: 'Messages are closed for this request.',
    });
  });
});
