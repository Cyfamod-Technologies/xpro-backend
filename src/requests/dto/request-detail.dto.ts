import type { RequestStage, NextActor, ViewerNextActor } from '../domain/stage';
import type { RequestStatus } from '../domain/statuses';
import type { AnswerSnapshot } from '../domain/answers';

export type RequestRole = 'customer' | 'provider' | 'staff';
export interface RequestScheduleView {
  id: string;
  status: string;
  startAt: Date;
  endAt: Date;
  note: string;
  customer: string;
  provider: string;
  confirmedAt: Date | null;
}
export interface RequestIssueView {
  id: string;
  status: string;
  note: string;
  outcome: string | null;
  createdAt: Date;
}
export interface RequestCancellationView {
  id: string;
  status: string;
  reasonCode: string;
  note: string;
  refundStatus: string | null;
  createdAt: Date;
}
export interface RequestNoShowView {
  id: string;
  scheduleId: string;
  status: string;
  /** The no-show row version the decision and correction commands require. */
  version: number;
  note: string;
  createdAt: Date;
}
export interface RequestGroupSummary {
  id: string;
  ref: string;
  title: string;
}
export interface RequestSiblingView {
  /** The sibling's `XPR-nnnnn` id. */
  id: string;
  title: string;
  serviceName: string;
  status: RequestStatus;
  stage: RequestStage;
}
export interface RequestDetailDto {
  id: string;
  version: number;
  status: RequestStatus;
  stage: RequestStage;
  statusLabel: string | null;
  /** Raw for staff; `customer`, `provider`, `xpro` or `none` for the other roles (A-22). */
  nextActor: NextActor | ViewerNextActor;
  allowedActions: string[];
  overlays: {
    cancellation: string | null;
    flag: string | null;
    suspendedParties: string[];
  };
  title?: string;
  service?: string;
  locationId?: string;
  /** Root first, ending with the chosen place. */
  locationPath?: ReadonlyArray<{ id: string; kind: string; name: string }>;
  /** Names from the chosen place to the state, e.g. `Life Camp, Abuja Municipal, FCT`. */
  locationLabel?: string | null;
  address?: string;
  phone?: string;
  contactMethod?: string;
  description?: string;
  budget?: number | null;
  startDate?: string | null;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
  details?: Record<string, unknown>;
  servicePath?: unknown;
  answers?: Array<Partial<AnswerSnapshot>>;
  customerName?: string;
  ownerId?: string;
  staffOwnerId?: string | null;
  /** Staff only (04 §11.2): the owner's limit override, the limit in force and the requests counted against it. */
  customerRequestLimit?: {
    userId: string;
    override: number | null;
    effective: number;
    open: number;
  };
  /** Customer and staff only, on `GET /requests/:id` (04 §4.1a). `null` for a request created alone. */
  group?: RequestGroupSummary | null;
  /** Customer and staff only: the other requests of the same group in `groupPosition` order, `[]` when ungrouped. */
  siblings?: RequestSiblingView[];
  claimedAt?: Date | null;
  unclaimedSince?: Date | null;
  ownershipVersion?: number;
  intake?: { state: string; clarificationCount: number };
  /** Staff only (04 §10: flags are never shown to customers or providers). */
  contactInBrief?: boolean;
  attachments?: Array<{
    id: string;
    name: string;
    size: number;
    type: string;
    uploadedAt: Date;
    sharedWithProvider: boolean;
  }>;
  assignment?: Record<string, unknown> | Array<Record<string, unknown>> | null;
  provider?: { businessName: string; trade: string; verified: boolean } | null;
  quote?: Record<string, unknown> | null;
  schedule?: RequestScheduleView | null;
  schedules?: RequestScheduleView[];
  issues?: RequestIssueView[];
  cancellations?: RequestCancellationView[];
  noShows?: RequestNoShowView[];
  completion?: {
    reportedAt: Date | null;
    confirmationDueAt: Date | null;
    acknowledgedAt: Date | null;
    defectsWindowEndsAt: Date | null;
  } | null;
  contributions?: Array<Record<string, unknown>>;
  dispatch?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  warning?: string;
}
