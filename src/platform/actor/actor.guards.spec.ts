import { AppError } from '../errors/app-error';
import {
  requireActiveStaff,
  requireAnyPermission,
  requireCustomer,
  requirePermission,
  requireProvider,
} from './actor.guards';
import type { ActorContext } from './actor.types';

const customer: ActorContext = {
  userId: 'c',
  kind: 'customer',
  displayName: 'C',
  platformRoles: ['customer'],
  accountActive: true,
};
const provider: ActorContext = {
  ...customer,
  kind: 'provider',
  platformRoles: ['customer', 'provider'],
};
const staff = (
  status: 'active' | 'suspended',
  permissions: string[],
): ActorContext => ({
  userId: 's',
  kind: 'staff',
  displayName: 'S',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status,
    roles: ['pricing'],
    permissions: new Set(permissions) as never,
    canOwn: false,
    isSuperAdmin: false,
    permVersion: 1,
  },
});

function failure(fn: () => void) {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected an AppError');
}

const ACCOUNT_TYPE = 'This action is not available for your account type.';

describe('actor guards', () => {
  it('requireCustomer and requireProvider check platform roles', () => {
    expect(() => requireCustomer(customer)).not.toThrow();
    expect(() => requireCustomer(provider)).not.toThrow();
    expect(() => requireProvider(provider)).not.toThrow();
    const err = failure(() => requireProvider(customer));
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe(ACCOUNT_TYPE);
    expect(failure(() => requireCustomer(staff('active', []))).message).toBe(
      ACCOUNT_TYPE,
    );
  });

  it('requirePermission checks type, then status, then permission', () => {
    expect(
      failure(() => requirePermission(customer, 'quote.manage')).message,
    ).toBe(ACCOUNT_TYPE);
    expect(
      failure(() => requirePermission(staff('suspended', []), 'quote.manage'))
        .message,
    ).toBe('Your staff account is not active.');
    expect(
      failure(() => requirePermission(staff('active', []), 'quote.manage'))
        .message,
    ).toBe('Your staff role does not allow this action.');
    expect(() =>
      requirePermission(staff('active', ['quote.manage']), 'quote.manage'),
    ).not.toThrow();
  });

  it('requireAnyPermission passes with one match', () => {
    const actor = staff('active', ['request.clarify']);
    expect(() =>
      requireAnyPermission(actor, ['request.review', 'request.clarify']),
    ).not.toThrow();
    const err = failure(() =>
      requireAnyPermission(actor, ['request.review', 'request.close']),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Your staff role does not allow this action.');
    expect(
      failure(() => requireAnyPermission(customer, ['request.review'])).message,
    ).toBe(ACCOUNT_TYPE);
  });

  it('requireActiveStaff narrows to active staff', () => {
    expect(() => requireActiveStaff(staff('active', []))).not.toThrow();
    expect(
      failure(() => requireActiveStaff(staff('suspended', []))).message,
    ).toBe('Your staff account is not active.');
  });

  it('lets a caller keep its own wording', () => {
    expect(
      failure(() =>
        requirePermission(customer, 'provider.review', {
          accountType: 'x',
          inactive: 'y',
          denied: 'z',
        }),
      ).message,
    ).toBe('x');
    expect(
      failure(() =>
        requirePermission(staff('suspended', []), 'provider.review', {
          inactive: 'y',
        }),
      ).message,
    ).toBe('y');
    expect(
      failure(() =>
        requirePermission(staff('active', []), 'provider.review', {
          denied: 'z',
        }),
      ).message,
    ).toBe('z');
  });
});
