import type { WorkspaceRole } from '@prisma/client';

/**
 * The workspace an account is using: its one role, or `users.last_active_role`
 * when it holds both (ROLE-1; a provider until it first switches). `null` for
 * staff and for accounts with neither role.
 */
export function activeWorkspaceRole(
  platformRoles: readonly string[],
  lastActiveRole: WorkspaceRole | null | undefined,
): WorkspaceRole | null {
  if (platformRoles.includes('staff')) return null;
  const customer = platformRoles.includes('customer');
  const provider = platformRoles.includes('provider');
  if (customer && provider) return lastActiveRole ?? 'provider';
  if (provider) return 'provider';
  if (customer) return 'customer';
  return null;
}
