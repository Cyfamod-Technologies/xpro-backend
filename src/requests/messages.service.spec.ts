import type { ActorContext } from '../platform/actor/actor.types';
import { canReadChannel, canWriteChannel, renderAuthor } from './messages.service';

const assignment = { providerId: 'provider-1', providerUserId: 'provider-user-1', status: 'accepted' };
const customer: ActorContext = {
  userId: 'customer-1', kind: 'customer', displayName: 'Casey Customer', platformRoles: ['customer'], accountActive: true,
};
const provider: ActorContext = {
  userId: 'provider-user-1', kind: 'provider', displayName: 'Pat Provider', platformRoles: ['provider'], accountActive: true,
};
const formerProvider: ActorContext = { ...provider, userId: 'former-provider' };
const staff: ActorContext = {
  userId: 'staff-1', kind: 'staff', displayName: 'Sam Staff', platformRoles: ['staff'], accountActive: true,
  staff: { status: 'active', roles: ['client_relations'], permissions: new Set(['message.customer', 'message.internal']), canOwn: true, isSuperAdmin: false, permVersion: 1 },
};

describe('request message channel access', () => {
  it('keeps customers in their own channel and rejects provider channels with the documented message', () => {
    expect(canReadChannel(customer, 'customer-1', 'customer', null, assignment)).toBe(true);
    expect(canWriteChannel(customer, 'customer-1', 'customer', null, assignment)).toBe(true);
    expect(canReadChannel(customer, 'customer-1', 'provider', 'provider-1', assignment)).toBe(false);
    expect(canWriteChannel(customer, 'customer-1', 'internal', null, assignment)).toBe(false);
  });

  it('allows only the current offered or assigned provider thread', () => {
    expect(canReadChannel(provider, 'customer-1', 'provider', 'provider-1', assignment)).toBe(true);
    expect(canWriteChannel(provider, 'customer-1', 'provider', 'provider-1', assignment)).toBe(true);
    expect(canReadChannel(formerProvider, 'customer-1', 'provider', 'provider-1', assignment)).toBe(false);
    expect(canWriteChannel(formerProvider, 'customer-1', 'provider', 'provider-1', assignment)).toBe(false);
    expect(canReadChannel(provider, 'customer-1', 'customer', null, assignment)).toBe(false);
  });

  it('enforces the matching staff permission for each channel', () => {
    expect(canReadChannel(staff, 'customer-1', 'customer', null, assignment)).toBe(true);
    expect(canReadChannel(staff, 'customer-1', 'internal', null, assignment)).toBe(true);
    expect(canReadChannel(staff, 'customer-1', 'provider', 'provider-1', assignment)).toBe(false);
    expect(canWriteChannel(staff, 'customer-1', 'provider', 'provider-1', assignment)).toBe(false);
  });
});

describe('request message author labels', () => {
  const staffNames = new Map([['staff-1', 'Sam Staff']]);

  it('masks staff names from customers and providers while keeping staff identities in staff views', () => {
    expect(renderAuthor('staff', 'staff-1', customer, staffNames)).toBe('XPro Team');
    expect(renderAuthor('staff', 'staff-1', provider, staffNames)).toBe('XPro Dispatch');
    expect(renderAuthor('staff', 'staff-1', staff, staffNames)).toBe('Sam Staff');
  });
});
