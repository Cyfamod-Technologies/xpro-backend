import { StaffRole, StaffStatus } from '@prisma/client';

export const STAFF_PERMISSIONS = [
  'request.claim',
  'request.review',
  'request.clarify',
  'request.cancel',
  'request.cancel.active',
  'request.escalate',
  'request.escalation.resolve',
  'request.reassign',
  'request.close',
  'provider.review',
  'account.suspend',
  'dispatch.manage',
  'schedule.manage',
  'progress.review',
  'issue.resolve',
  'quote.manage',
  'quote.approve',
  'bank.review',
  'payment.record',
  'payout.approve',
  'refund.manage',
  'message.customer',
  'message.provider',
  'message.internal',
  'staff.manage',
  'staff.mfa.reset',
  'settings.manage',
  'audit.export',
  'view.customer_contact',
  'view.provider_identity',
  'view.bank_full',
  'view.pricing',
  'view.audit_sensitive',
  'view.audit_bank',
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

const presets: Record<
  Exclude<StaffRole, 'super_admin'>,
  readonly StaffPermission[]
> = {
  operations: [
    'request.claim',
    'request.review',
    'request.clarify',
    'request.cancel',
    'request.cancel.active',
    'request.escalate',
    'request.escalation.resolve',
    'request.reassign',
    'request.close',
    'provider.review',
    'account.suspend',
    'dispatch.manage',
    'schedule.manage',
    'progress.review',
    'issue.resolve',
    'message.customer',
    'message.provider',
    'message.internal',
    'view.customer_contact',
    'view.provider_identity',
  ],
  pricing: [
    'request.escalate',
    'quote.manage',
    'message.provider',
    'message.internal',
    'view.pricing',
  ],
  client_relations: [
    'request.clarify',
    'request.cancel',
    'request.escalate',
    'issue.resolve',
    'message.customer',
    'message.provider',
    'message.internal',
    'view.customer_contact',
  ],
  finance: [
    'request.escalate',
    'bank.review',
    'payment.record',
    'payout.approve',
    'refund.manage',
    'message.provider',
    'message.internal',
    'view.bank_full',
    'view.pricing',
    'view.audit_bank',
  ],
};

export function permissionsForRoles(
  roles: readonly StaffRole[],
): StaffPermission[] {
  if (roles.includes(StaffRole.super_admin)) return [...STAFF_PERMISSIONS];
  return [
    ...new Set(
      roles
        .filter((role) => role !== StaffRole.super_admin)
        .flatMap((role) => presets[role]),
    ),
  ];
}

export function canOwnRequests(
  status: StaffStatus,
  roles: readonly StaffRole[],
): boolean {
  if (status !== StaffStatus.active) return false;
  const permissions = new Set(permissionsForRoles(roles));
  return [
    'request.claim',
    'request.review',
    'dispatch.manage',
    'progress.review',
    'schedule.manage',
    'issue.resolve',
    'request.close',
  ].every((permission) => permissions.has(permission as StaffPermission));
}
