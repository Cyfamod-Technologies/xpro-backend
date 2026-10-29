import type { GuardRegistry } from './allowed-actions';
import type { GuardResult } from './guards/types';
import type {
  ActorView,
  AssignmentSnapshot,
  QuoteSnapshot,
  RequestSnapshot,
  ScheduleSnapshot,
} from './snapshot';

export const NOW = new Date('2026-10-25T10:00:00.000Z');
export const HOUR = 60 * 60_000;

export function snapshot(
  overrides: Partial<RequestSnapshot> = {},
): RequestSnapshot {
  return {
    id: 'request-1',
    number: 'XPR-00001',
    ownerId: 'customer-1',
    staffOwnerId: null,
    currentProviderUserId: null,
    status: 'submitted',
    intake: { state: 'pending' },
    currentAssignment: null,
    assignments: [],
    latestQuote: null,
    latestSentQuote: null,
    quotes: [],
    currentSchedule: null,
    replacedSchedule: null,
    pendingUpdates: [],
    openIssues: [],
    pendingCancellation: false,
    pendingCancellationInfo: null,
    refundsOutstanding: 0,
    latestNoShow: null,
    payment: { paid: false, pendingPaymentAt: null, offlineRecorded: false },
    payout: null,
    customerStanding: 'active',
    providerStanding: null,
    cascadePending: false,
    autoAttempts: 0,
    ...overrides,
  };
}

export const assignment = (
  status: AssignmentSnapshot['status'],
  overrides: Partial<AssignmentSnapshot> = {},
): AssignmentSnapshot => ({
  status,
  attempt: 1,
  expiresAt: new Date(NOW.getTime() + 24 * HOUR),
  ...overrides,
});

export const quote = (
  status: QuoteSnapshot['status'],
  overrides: Partial<QuoteSnapshot> = {},
): QuoteSnapshot => ({
  status,
  version: 1,
  approvalRequestedAt: null,
  validUntil: null,
  payoutAmount: null,
  ...overrides,
});

export const schedule = (
  status: ScheduleSnapshot['status'],
  overrides: Partial<ScheduleSnapshot> = {},
): ScheduleSnapshot => ({
  status,
  startAt: new Date(NOW.getTime() + 48 * HOUR),
  endAt: new Date(NOW.getTime() + 52 * HOUR),
  customer: 'pending',
  provider: 'pending',
  changeRequests: [],
  ...overrides,
});

export const customer = (userId = 'customer-1'): ActorView => ({
  kind: 'customer',
  userId,
  platformRoles: ['customer'],
});
export const provider = (userId = 'provider-1'): ActorView => ({
  kind: 'provider',
  userId,
  platformRoles: ['provider'],
});
export const staff = (...permissions: string[]): ActorView => ({
  kind: 'staff',
  userId: 'staff-1',
  platformRoles: ['staff'],
  permissions: new Set(permissions),
  canOwn: true,
});
export const system: ActorView = { kind: 'system', userId: null };

export function check(
  registry: GuardRegistry,
  key: string,
  snap: RequestSnapshot,
  actor: ActorView,
  input?: unknown,
  settings: Record<string, unknown> = {},
  now: Date = NOW,
): GuardResult {
  const guard = registry[key];
  if (!guard) throw new Error(`No guard registered for ${key}`);
  return guard(snap, actor, input, now, settings);
}

export const failure = (
  status: 403 | 404 | 409 | 422,
  code: string,
  message: string,
) => ({ ok: false, status, code, message });
