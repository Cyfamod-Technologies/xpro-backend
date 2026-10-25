import { providerBlocked } from './provider-standing';

describe('providerBlocked', () => {
  const ok = {
    userStatus: 'active',
    verification: 'approved',
    reliabilityStatus: 'normal',
  };

  it('does not block an active, approved, normal provider', () => {
    expect(providerBlocked(ok)).toEqual({ blocked: false, reason: null });
  });

  it.each(['normal', 'review_due', 'under_review'])(
    'does not block reliability status %s',
    (reliabilityStatus) => {
      expect(providerBlocked({ ...ok, reliabilityStatus }).blocked).toBe(false);
    },
  );

  it.each(['suspended', 'inactive', 'deactivated', 'pending_deletion'])(
    'blocks a user account that is %s',
    (userStatus) => {
      expect(providerBlocked({ ...ok, userStatus })).toEqual({
        blocked: true,
        reason: 'suspended',
      });
    },
  );

  it('blocks a delisted profile', () => {
    expect(providerBlocked({ ...ok, verification: 'delisted' })).toEqual({
      blocked: true,
      reason: 'delisted',
    });
  });

  it('blocks a restricted provider', () => {
    expect(providerBlocked({ ...ok, reliabilityStatus: 'restricted' })).toEqual(
      { blocked: true, reason: 'restricted' },
    );
  });

  it('reports the account problem first when several apply', () => {
    expect(
      providerBlocked({
        userStatus: 'suspended',
        verification: 'delisted',
        reliabilityStatus: 'restricted',
      }).reason,
    ).toBe('suspended');
    expect(
      providerBlocked({
        ...ok,
        verification: 'delisted',
        reliabilityStatus: 'restricted',
      }).reason,
    ).toBe('delisted');
  });

  it('does not block on missing data alone', () => {
    expect(
      providerBlocked({
        userStatus: null,
        verification: null,
        reliabilityStatus: null,
      }).blocked,
    ).toBe(false);
  });
});
