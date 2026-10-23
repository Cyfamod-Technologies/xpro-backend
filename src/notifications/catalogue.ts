import type { StaffPermission } from '../staff/staff-permissions';

export type NotificationAudience =
  | { kind: 'customer' }
  | { kind: 'provider:current' }
  | { kind: 'provider:assignment' }
  | { kind: 'staff:gated'; permission: StaffPermission }
  | { kind: 'staff:info' }
  | { kind: 'staff:unclaimed' }
  | { kind: 'staff:pricing' }
  | { kind: 'staff:recipient' }
  | { kind: 'staff:holders'; permission: StaffPermission }
  | { kind: 'message:participants' };

export interface CatalogueEntry<P> {
  key: string;
  audience: NotificationAudience;
  /** Mandatory customer and provider events also get an `email.notify` outbox row. */
  mandatory: boolean;
  title: (params: P) => string;
  message: (params: P) => string;
  link: (params: P) => string | null;
}

function entry<P>(definition: CatalogueEntry<P>): CatalogueEntry<P> {
  return definition;
}

type RequestParams = { requestCode: string };
type RequestUpdateParams = { requestCode: string; fields?: string[] };
type RequestReasonParams = { requestCode: string; reason: string };
type OwnershipNoticeParams = { recipientId: string; requestCode: string; note: string };
type MessageUpdateParams = { requestCode: string; channel: 'customer' | 'provider' | 'internal'; providerId: string | null };

/**
 * Titles and messages come from 04 §6 and §9. Wording marked "new message" is
 * not in the spec yet and needs a spec home; later work packages add the rest.
 */
export const NOTIFICATION_CATALOGUE = {
  'request.received': entry<RequestParams>({
    key: 'request.received',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Request received',
    // new message: not in spec
    message: ({ requestCode }) =>
      `We have received your request ${requestCode}.`,
    link: () => '/requests',
  }),
  'request.needs_owner': entry<RequestParams>({
    key: 'request.needs_owner',
    audience: { kind: 'staff:info' },
    mandatory: false,
    title: () => 'Request needs an owner',
    // new message: not in spec
    message: ({ requestCode }) => `${requestCode} has no owner yet.`,
    link: () => '/admin/requests?owner=unclaimed',
  }),
  'request.owner_released': entry<OwnershipNoticeParams>({
    key: 'request.owner_released', audience: { kind: 'staff:recipient' }, mandatory: false,
    title: () => 'Request released',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.handed_to_you': entry<OwnershipNoticeParams>({
    key: 'request.handed_to_you', audience: { kind: 'staff:recipient' }, mandatory: false,
    title: () => 'Request handed to you',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.assigned_to_you': entry<OwnershipNoticeParams>({
    key: 'request.assigned_to_you', audience: { kind: 'staff:recipient' }, mandatory: false,
    title: () => 'Request assigned to you',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.owner_reassigned': entry<OwnershipNoticeParams>({
    key: 'request.owner_reassigned', audience: { kind: 'staff:recipient' }, mandatory: false,
    title: () => 'Request reassigned',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.submitted': entry<RequestParams>({
    key: 'request.submitted',
    audience: { kind: 'staff:unclaimed' },
    mandatory: false,
    title: () => 'Request submitted',
    message: ({ requestCode }) => `${requestCode} has been submitted and needs intake review.`,
    link: () => '/admin/requests?owner=unclaimed',
  }),
  'request.updated_by_staff': entry<RequestUpdateParams>({
    key: 'request.updated_by_staff',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'XPro updated your request',
    message: ({ requestCode, fields = [] }) => `${requestCode} was updated by XPro${fields.length ? `: ${fields.join(', ')}.` : '.'}`,
    link: () => '/requests',
  }),
  'request.updated_by_customer': entry<RequestUpdateParams>({
    key: 'request.updated_by_customer',
    audience: { kind: 'staff:unclaimed' },
    mandatory: false,
    title: () => 'Customer updated the request',
    message: ({ requestCode }) => `${requestCode} was updated by the customer.`,
    link: () => '/admin/requests?owner=unclaimed',
  }),
  'request.offer_withdrawn': entry<RequestParams & { assignmentId: string; service: string; district: string }>({
    key: 'request.offer_withdrawn',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Offer withdrawn',
    message: ({ service, district }) => `${service} in ${district}: the request changed. XPro may send you a new offer.`,
    link: () => null,
  }),
  'request.clarification_answered': entry<RequestParams>({
    key: 'request.clarification_answered',
    audience: { kind: 'staff:unclaimed' },
    mandatory: false,
    title: () => 'Customer answered your question',
    message: ({ requestCode }) => `${requestCode}: the customer answered the clarification.`,
    link: () => '/admin/requests?owner=unclaimed',
  }),
  'request.clarification_requested': entry<RequestParams>({
    key: 'request.clarification_requested',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Clarification requested',
    // new message: not in spec
    message: ({ requestCode }) =>
      `XPro Team has a question about ${requestCode}. Open your messages to reply.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.approved': entry<RequestParams>({
    key: 'request.approved', audience: { kind: 'customer' }, mandatory: true,
    title: () => 'Request approved',
    message: ({ requestCode }) => `XPro approved ${requestCode} and is finding a verified provider for you.`,
    link: () => '/requests',
  }),
  'request.needs_manual_assignment': entry<RequestParams>({
    key: 'request.needs_manual_assignment', audience: { kind: 'staff:holders', permission: 'dispatch.manage' }, mandatory: false,
    title: () => 'Needs manual assignment',
    message: ({ requestCode }) => `${requestCode} needs a provider to be assigned manually.`,
    link: () => '/admin/requests?status=needs_assignment',
  }),
  'request.rejected': entry<RequestReasonParams>({
    key: 'request.rejected', audience: { kind: 'customer' }, mandatory: true,
    title: () => 'Request not accepted',
    message: ({ reason }) => reason,
    link: () => '/requests',
  }),
  'request.clarification_reminder': entry<RequestParams>({
    key: 'request.clarification_reminder', audience: { kind: 'customer' }, mandatory: false,
    title: () => 'Please answer XPro’s question',
    message: ({ requestCode }) => `XPro is waiting for your reply about ${requestCode}. Open your messages to answer.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.clarification_overdue': entry<RequestParams>({
    key: 'request.clarification_overdue', audience: { kind: 'staff:holders', permission: 'request.clarify' }, mandatory: false,
    title: () => 'Clarification overdue',
    message: ({ requestCode }) => `${requestCode} has been awaiting a customer response for five days.`,
    link: () => '/admin/requests?intake=clarification',
  }),
  'request.clarification_final_warning': entry<RequestParams>({
    key: 'request.clarification_final_warning', audience: { kind: 'customer' }, mandatory: true,
    title: () => 'Final reminder: reply to XPro',
    message: ({ requestCode }) => `Reply about ${requestCode} within 24 hours or XPro will cancel the request.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.message_update': entry<MessageUpdateParams>({
    key: 'request.message_update',
    audience: { kind: 'message:participants' },
    mandatory: false,
    title: () => 'New conversation update',
    message: ({ requestCode }) => `${requestCode} has a new conversation update.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.auto_cancelled': entry<RequestParams>({
    key: 'request.auto_cancelled', audience: { kind: 'customer' }, mandatory: true,
    title: () => 'Request cancelled',
    message: ({ requestCode }) => `We closed ${requestCode} because we didn't hear back. You can submit a new request at any time.`,
    link: () => '/requests',
  }),
} as const;

export type NotificationEvent = keyof typeof NOTIFICATION_CATALOGUE;

export type NotificationParams<K extends NotificationEvent> = Parameters<
  (typeof NOTIFICATION_CATALOGUE)[K]['title']
>[0];

export interface RenderedNotification {
  event: string;
  audience: NotificationAudience;
  mandatory: boolean;
  title: string;
  message: string;
  link: string | null;
}

export function renderNotification<K extends NotificationEvent>(
  key: K,
  params: NotificationParams<K>,
): RenderedNotification {
  const definition = NOTIFICATION_CATALOGUE[key] as CatalogueEntry<
    NotificationParams<K>
  >;
  return {
    event: definition.key,
    audience: definition.audience,
    mandatory: definition.mandatory,
    title: definition.title(params),
    message: definition.message(params),
    link: definition.link(params),
  };
}
