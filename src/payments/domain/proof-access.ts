import type { StaffPermission } from '../../staff/staff-permissions';

export type ProofEntity = 'payment' | 'refund' | 'payout';

/** Who may download the proof file attached to a money record (05 §4.2, §4.3). */
export const PROOF_PERMISSION: Readonly<Record<ProofEntity, StaffPermission>> =
  {
    payment: 'payment.record',
    refund: 'refund.manage',
    payout: 'payout.approve',
  };

type ProofViewer = {
  accountActive: boolean;
  staff?: {
    status: string;
    isSuperAdmin: boolean;
    permissions: ReadonlySet<StaffPermission>;
  };
} | null;

/**
 * Active staff who hold the entity's permission, plus active super admins.
 * Everyone else (customers, providers, other staff) is refused.
 */
export function mayAccessProof(
  entity: ProofEntity,
  viewer: ProofViewer,
): boolean {
  if (!viewer?.accountActive) return false;
  const staff = viewer.staff;
  if (!staff || staff.status !== 'active') return false;
  return staff.isSuperAdmin || staff.permissions.has(PROOF_PERMISSION[entity]);
}
