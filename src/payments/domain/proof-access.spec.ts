import type { StaffPermission } from '../../staff/staff-permissions';
import { mayAccessProof, type ProofEntity } from './proof-access';

const viewer = (
  permissions: StaffPermission[],
  overrides: {
    status?: string;
    isSuperAdmin?: boolean;
    accountActive?: boolean;
  } = {},
) => ({
  accountActive: overrides.accountActive ?? true,
  staff: {
    status: overrides.status ?? 'active',
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    permissions: new Set(permissions),
  },
});

describe('mayAccessProof', () => {
  const cases: Array<[ProofEntity, StaffPermission]> = [
    ['payment', 'payment.record'],
    ['refund', 'refund.manage'],
    ['payout', 'payout.approve'],
  ];

  it.each(cases)(
    'lets %s proof through for %s holders',
    (entity, permission) => {
      expect(mayAccessProof(entity, viewer([permission]))).toBe(true);
    },
  );

  it.each(cases)(
    'refuses %s proof to staff holding another permission',
    (entity, permission) => {
      const others = cases
        .map(([, other]) => other)
        .filter((p) => p !== permission);
      expect(mayAccessProof(entity, viewer(others))).toBe(false);
      expect(mayAccessProof(entity, viewer([]))).toBe(false);
    },
  );

  it.each(cases)('lets an active super admin open %s proof', (entity) => {
    expect(mayAccessProof(entity, viewer([], { isSuperAdmin: true }))).toBe(
      true,
    );
  });

  it('refuses suspended staff and super admins', () => {
    expect(
      mayAccessProof(
        'payment',
        viewer(['payment.record'], { status: 'suspended' }),
      ),
    ).toBe(false);
    expect(
      mayAccessProof(
        'payment',
        viewer([], { isSuperAdmin: true, status: 'suspended' }),
      ),
    ).toBe(false);
  });

  it('refuses an inactive account', () => {
    expect(
      mayAccessProof(
        'payout',
        viewer(['payout.approve'], { accountActive: false }),
      ),
    ).toBe(false);
  });

  it('refuses customers and providers', () => {
    expect(mayAccessProof('payment', { accountActive: true })).toBe(false);
    expect(mayAccessProof('refund', null)).toBe(false);
  });
});
