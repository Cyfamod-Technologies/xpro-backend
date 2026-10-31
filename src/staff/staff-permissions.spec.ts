import { StaffRole } from '@prisma/client';
import { permissionsForRoles, STAFF_PERMISSIONS } from './staff-permissions';

describe('account.limit permission (MS-7)', () => {
  it('is a staff permission', () => {
    expect(STAFF_PERMISSIONS).toContain('account.limit');
  });

  it('goes to super admin and the operations preset only', () => {
    expect(permissionsForRoles([StaffRole.super_admin])).toContain(
      'account.limit',
    );
    expect(permissionsForRoles([StaffRole.operations])).toContain(
      'account.limit',
    );
    for (const role of [
      StaffRole.pricing,
      StaffRole.client_relations,
      StaffRole.finance,
    ])
      expect(permissionsForRoles([role])).not.toContain('account.limit');
  });
});
