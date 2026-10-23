import type { PlatformRole, StaffRole, StaffStatus } from '@prisma/client';
import type { StaffPermission } from '../../staff/staff-permissions';

export type ActorKind = 'customer' | 'provider' | 'staff' | 'system';

export type ActorStaff = {
  status: StaffStatus;
  roles: StaffRole[];
  /** Empty unless the staff member is active. */
  permissions: ReadonlySet<StaffPermission>;
  canOwn: boolean;
  isSuperAdmin: boolean;
  permVersion: number;
};

export type ActorContext = {
  /** `null` for the system and the dispatch engine. */
  userId: string | null;
  /** Staff wins over provider, provider over customer; use `platformRoles` to ask what an account may do. */
  kind: ActorKind;
  displayName: string;
  platformRoles: PlatformRole[];
  /** `users.status === 'active'`. */
  accountActive: boolean;
  /** Present for any staff account (a `staff` platform role plus a staff member row), active or not. */
  staff?: ActorStaff;
};

export const SYSTEM_ACTOR: ActorContext = Object.freeze({
  userId: null,
  kind: 'system',
  displayName: 'XPro system',
  platformRoles: [],
  accountActive: true,
});

export const ENGINE_ACTOR: ActorContext = Object.freeze({
  userId: null,
  kind: 'system',
  displayName: 'Auto-assign rules v1',
  platformRoles: [],
  accountActive: true,
});
