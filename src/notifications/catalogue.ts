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
  /** Every active holder of the permission, super admins included, for mandatory money alerts (05 §9). */
  | { kind: 'staff:all_holders'; permission: StaffPermission }
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
type OwnershipNoticeParams = {
  recipientId: string;
  requestCode: string;
  note: string;
};
type MessageUpdateParams = {
  requestCode: string;
  channel: 'customer' | 'provider' | 'internal';
  providerId: string | null;
};
type AssignmentNoticeParams = RequestParams & {
  assignmentId: string;
  providerUserId: string;
  service: string;
  district: string;
  skill?: string;
};
type PayoutProviderParams = RequestParams & {
  assignmentId: string;
  providerUserId: string;
};
type QuoteNoticeParams = RequestParams & { note?: string };
type QuoteAcceptedParams = RequestParams & { amount: number; dueDate: string };

const naira = (kobo: number) =>
  (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });

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
    key: 'request.owner_released',
    audience: { kind: 'staff:recipient' },
    mandatory: false,
    title: () => 'Request released',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.handed_to_you': entry<OwnershipNoticeParams>({
    key: 'request.handed_to_you',
    audience: { kind: 'staff:recipient' },
    mandatory: false,
    title: () => 'Request handed to you',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.assigned_to_you': entry<OwnershipNoticeParams>({
    key: 'request.assigned_to_you',
    audience: { kind: 'staff:recipient' },
    mandatory: false,
    title: () => 'Request assigned to you',
    // new message: the spec supplies the title and note, but not a body template.
    message: ({ requestCode, note }) => `${requestCode}: ${note}`,
    link: () => '/admin/requests',
  }),
  'request.owner_reassigned': entry<OwnershipNoticeParams>({
    key: 'request.owner_reassigned',
    audience: { kind: 'staff:recipient' },
    mandatory: false,
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
    message: ({ requestCode }) =>
      `${requestCode} has been submitted and needs intake review.`,
    link: () => '/admin/requests?owner=unclaimed',
  }),
  'request.updated_by_staff': entry<RequestUpdateParams>({
    key: 'request.updated_by_staff',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'XPro updated your request',
    message: ({ requestCode, fields = [] }) =>
      `${requestCode} was updated by XPro${fields.length ? `: ${fields.join(', ')}.` : '.'}`,
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
  // new message: not in spec
  'request.offer_withdrawn': entry<
    RequestParams & {
      assignmentId: string;
      service: string;
      district: string;
      skill?: string;
    }
  >({
    key: 'request.offer_withdrawn',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Offer withdrawn',
    message: ({ service, skill, district }) =>
      `${skill || service} in ${district}: the request changed. XPro may send you a new offer.`,
    link: () => null,
  }),
  // new message: not in spec
  'request.details_shared': entry<
    RequestParams & { assignmentId: string; providerUserId: string }
  >({
    key: 'request.details_shared',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'New job details shared',
    message: ({ requestCode }) =>
      `XPro shared additional details for ${requestCode}.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'request.provider_standing_changed': entry<
    RequestParams & { reason: string }
  >({
    key: 'request.provider_standing_changed',
    audience: { kind: 'staff:holders', permission: 'dispatch.manage' },
    mandatory: false,
    title: () => 'Provider availability changed',
    message: ({ requestCode, reason }) =>
      `${requestCode}: the assigned provider's standing changed. ${reason}`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'request.customer_suspended': entry<RequestParams>({
    key: 'request.customer_suspended',
    audience: { kind: 'staff:holders', permission: 'request.review' },
    mandatory: false,
    title: () => 'Customer account suspended',
    message: ({ requestCode }) =>
      `${requestCode} belongs to a suspended customer and needs review.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  'request.clarification_answered': entry<RequestParams>({
    key: 'request.clarification_answered',
    audience: { kind: 'staff:unclaimed' },
    mandatory: false,
    title: () => 'Customer answered your question',
    message: ({ requestCode }) =>
      `${requestCode}: the customer answered the clarification.`,
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
    key: 'request.approved',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Request approved',
    message: ({ requestCode }) =>
      `XPro approved ${requestCode} and is finding a verified provider for you.`,
    link: () => '/requests',
  }),
  'request.needs_manual_assignment': entry<RequestParams>({
    key: 'request.needs_manual_assignment',
    audience: { kind: 'staff:holders', permission: 'dispatch.manage' },
    mandatory: false,
    title: () => 'Needs manual assignment',
    message: ({ requestCode }) =>
      `${requestCode} needs a provider to be assigned manually.`,
    link: () => '/admin/requests?status=needs_assignment',
  }),
  'request.rejected': entry<RequestReasonParams>({
    key: 'request.rejected',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Request not accepted',
    message: ({ reason }) => reason,
    link: () => '/requests',
  }),
  'request.clarification_reminder': entry<RequestParams>({
    key: 'request.clarification_reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Please answer XPro’s question',
    message: ({ requestCode }) =>
      `XPro is waiting for your reply about ${requestCode}. Open your messages to answer.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.clarification_overdue': entry<RequestParams>({
    key: 'request.clarification_overdue',
    audience: { kind: 'staff:holders', permission: 'request.clarify' },
    mandatory: false,
    title: () => 'Clarification overdue',
    message: ({ requestCode }) =>
      `${requestCode} has been awaiting a customer response for five days.`,
    link: () => '/admin/requests?intake=clarification',
  }),
  'request.clarification_final_warning': entry<RequestParams>({
    key: 'request.clarification_final_warning',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Final reminder: reply to XPro',
    message: ({ requestCode }) =>
      `Reply about ${requestCode} within 24 hours or XPro will cancel the request.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.message_update': entry<MessageUpdateParams>({
    key: 'request.message_update',
    audience: { kind: 'message:participants' },
    mandatory: false,
    title: () => 'New conversation update',
    message: ({ requestCode }) =>
      `${requestCode} has a new conversation update.`,
    link: ({ requestCode }) => `/requests/${requestCode}/messages`,
  }),
  'request.auto_cancelled': entry<RequestParams>({
    key: 'request.auto_cancelled',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Request cancelled',
    message: ({ requestCode }) =>
      `We closed ${requestCode} because we didn't hear back. You can submit a new request at any time.`,
    link: () => '/requests',
  }),
  // new message: not in spec
  'assignment.offered': entry<AssignmentNoticeParams>({
    key: 'assignment.offered',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: ({ skill, district }) => `${skill || 'Service'} in ${district}`,
    message: ({ requestCode }) =>
      `You have a new service offer for ${requestCode}.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.accepted': entry<RequestParams>({
    key: 'assignment.accepted',
    audience: { kind: 'staff:gated', permission: 'dispatch.manage' },
    mandatory: false,
    title: () => 'Provider accepted — approval needed',
    message: ({ requestCode }) => `${requestCode} needs an assignment review.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.confirmed_customer': entry<RequestParams>({
    key: 'assignment.confirmed_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Provider matched',
    message: ({ requestCode }) =>
      `XPro confirmed a provider for ${requestCode}.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.confirmed_provider': entry<AssignmentNoticeParams>({
    key: 'assignment.confirmed_provider',
    audience: { kind: 'provider:assignment' },
    mandatory: true,
    title: () => 'Assignment confirmed by XPro',
    message: ({ requestCode }) =>
      `Your assignment for ${requestCode} is confirmed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.reminder': entry<AssignmentNoticeParams>({
    key: 'assignment.reminder',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Offer expires soon',
    message: ({ requestCode }) =>
      `Respond to the offer for ${requestCode} before it expires.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.expired': entry<AssignmentNoticeParams>({
    key: 'assignment.expired',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Offer expired',
    message: ({ requestCode }) => `The offer for ${requestCode} has expired.`,
    link: () => null,
  }),
  'assignment.not_confirmed': entry<
    RequestParams & {
      assignmentId: string;
      providerUserId: string;
      note: string;
    }
  >({
    key: 'assignment.not_confirmed',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Assignment not confirmed',
    // 04 §6.9: the staff note; no link, the provider loses access to the request.
    message: ({ note }) => note,
    link: () => null,
  }),
  // new message: not in spec
  'assignment.replaced_customer': entry<RequestParams>({
    key: 'assignment.replaced_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Your provider is being replaced',
    message: ({ requestCode }) =>
      `XPro is assigning a new provider for ${requestCode}. Your quote and payment stay as they are.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'assignment.replaced_provider': entry<AssignmentNoticeParams>({
    key: 'assignment.replaced_provider',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Assignment ended',
    message: ({ skill, service, district }) =>
      `${skill || service} in ${district}: XPro has replaced you on this job.`,
    link: () => null,
  }),
  // new message: not in spec
  'quote.contribution_submitted': entry<RequestParams>({
    key: 'quote.contribution_submitted',
    audience: { kind: 'staff:holders', permission: 'quote.manage' },
    mandatory: false,
    title: () => 'Provider pricing submitted',
    message: ({ requestCode }) =>
      `${requestCode} has provider costing ready for review.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.ready': entry<QuoteNoticeParams>({
    key: 'quote.ready',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Quote ready to review',
    message: ({ requestCode, note }) =>
      `A quote for ${requestCode} is ready to review.${note ? ` ${note}` : ''}`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.approval_needed': entry<RequestParams>({
    key: 'quote.approval_needed',
    audience: { kind: 'staff:holders', permission: 'quote.approve' },
    mandatory: false,
    title: () => 'Quote approval needed',
    message: ({ requestCode }) =>
      `${requestCode} has a quote awaiting sign-off.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.returned': entry<QuoteNoticeParams>({
    key: 'quote.returned',
    audience: { kind: 'staff:pricing' },
    mandatory: false,
    title: () => 'Quote returned',
    message: ({ requestCode, note }) =>
      `${requestCode}: ${note ?? 'Review the returned quote.'}`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.revision_requested': entry<QuoteNoticeParams>({
    key: 'quote.revision_requested',
    audience: { kind: 'staff:pricing' },
    mandatory: false,
    title: () => 'Quote revision requested',
    message: ({ requestCode, note }) =>
      `${requestCode}: ${note ?? 'The customer asked for changes.'}`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec (04 §6.11 names the notification, not its body)
  'quote.payment_due': entry<QuoteAcceptedParams>({
    key: 'quote.payment_due',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Payment due',
    message: ({ requestCode, amount, dueDate }) =>
      `Pay ₦${naira(amount)} for ${requestCode} by ${dueDate} to book your date.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec (04 §6.11 names the notification, not its body)
  'quote.accepted': entry<QuoteAcceptedParams>({
    key: 'quote.accepted',
    audience: { kind: 'staff:gated', permission: 'payment.record' },
    mandatory: false,
    title: () => 'Quote accepted, awaiting payment',
    message: ({ requestCode, dueDate }) =>
      `${requestCode}: the customer accepted the quote. Payment is due by ${dueDate}.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  'quote.accepted_provider': entry<RequestParams>({
    key: 'quote.accepted_provider',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'Customer accepted the quote',
    message: () => 'XPro will confirm the date once the customer has paid.',
    link: ({ requestCode }) => `/provider/requests/${requestCode}`,
  }),
  'quote.changes_requested_provider': entry<RequestParams>({
    key: 'quote.changes_requested_provider',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'Customer asked for changes',
    message: () => 'XPro may ask you to update your costing.',
    link: ({ requestCode }) => `/provider/requests/${requestCode}`,
  }),
  // new message: not in spec (04 §6.11 names the notification, not its body)
  'quote.declined': entry<RequestParams>({
    key: 'quote.declined',
    audience: { kind: 'staff:gated', permission: 'request.cancel' },
    mandatory: false,
    title: () => 'Quote declined — cancellation requested',
    message: ({ requestCode }) =>
      `${requestCode}: the customer declined the quote and asked to cancel.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.costing_reminder': entry<RequestParams>({
    key: 'quote.costing_reminder',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'Pricing update needed',
    message: ({ requestCode }) =>
      `${requestCode}: please submit your costing for the confirmed job.`,
    link: ({ requestCode }) => `/provider/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.stalled': entry<RequestParams>({
    key: 'quote.stalled',
    audience: { kind: 'staff:holders', permission: 'quote.manage' },
    mandatory: false,
    title: () => 'Pricing is stalled',
    message: ({ requestCode }) =>
      `${requestCode} has no provider costing. Review the request.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec
  'quote.payment_reminder': entry<RequestParams & { dueDate: string }>({
    key: 'quote.payment_reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Quote response needed',
    message: ({ requestCode, dueDate }) =>
      `${requestCode}: your quote is available until ${dueDate}.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // 04 §6.11 T8 copy.
  'quote.expired': entry<RequestParams & { version: number }>({
    key: 'quote.expired',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Quote expired',
    message: ({ requestCode, version }) =>
      `Quote v${version} for ${requestCode} has expired. XPro will send you an updated quote.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'payment.late': entry<RequestParams & { reference: string }>({
    key: 'payment.late',
    audience: { kind: 'staff:holders', permission: 'payment.record' },
    mandatory: false,
    title: () => 'Late payment needs a refund',
    message: ({ requestCode }) =>
      `${requestCode} received payment after payment was no longer due. Review the refund.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // 04 §6.12 T9 copy.
  'payment.reminder': entry<
    RequestParams & { amount: number; dueDate: string }
  >({
    key: 'payment.reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Payment reminder',
    message: ({ requestCode, amount, dueDate }) =>
      `Pay ₦${naira(amount)} for ${requestCode} by ${dueDate} to book your date.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // 04 §6.12 T9 copy.
  'payment.lapsed': entry<RequestParams>({
    key: 'payment.lapsed',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Payment window closed',
    message: ({ requestCode }) =>
      `Your quote for ${requestCode} expired because payment wasn't received. XPro will contact you.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'payment.settled_customer': entry<RequestParams>({
    key: 'payment.settled_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Payment received',
    message: ({ requestCode }) =>
      `Payment for ${requestCode} is confirmed. XPro will schedule the work.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'payment.settled_provider': entry<RequestParams>({
    key: 'payment.settled_provider',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Job paid — XPro will schedule',
    message: ({ requestCode }) =>
      `${requestCode} is paid. XPro will confirm the schedule.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // 04 §6.12 names the title; the body is new.
  'payment.settled_staff': entry<RequestParams>({
    key: 'payment.settled_staff',
    audience: { kind: 'staff:gated', permission: 'schedule.manage' },
    mandatory: false,
    title: () => 'Paid — schedule it',
    // new message: not in spec
    message: ({ requestCode }) =>
      `${requestCode} is paid and ready to schedule.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec (05 §9 names the event, not its wording)
  'payment.offline_recorded': entry<RequestParams>({
    key: 'payment.offline_recorded',
    audience: { kind: 'staff:holders', permission: 'payment.record' },
    mandatory: true,
    title: () => 'Offline payment to reconcile',
    message: ({ requestCode }) =>
      `${requestCode}: an offline payment was recorded. Another Finance member must reconcile it.`,
    link: () => '/admin/approvals',
  }),
  // new message: not in spec (05 §7 asks for a critical Finance/security alert)
  'payment.quarantined': entry<
    RequestParams & { reference: string; reason: string }
  >({
    key: 'payment.quarantined',
    audience: { kind: 'staff:all_holders', permission: 'payment.record' },
    mandatory: true,
    title: () => 'Payment needs manual reconciliation',
    message: ({ requestCode, reference, reason }) =>
      `${requestCode}: payment ${reference} was quarantined. ${reason} The request stays locked until Finance reconciles it.`,
    link: ({ requestCode }) => `/admin/requests/${requestCode}`,
  }),
  // new message: not in spec (05 §7 asks for a critical Finance/security alert)
  'payment.quarantined_unmatched': entry<{ reference: string; reason: string }>(
    {
      key: 'payment.quarantined_unmatched',
      audience: { kind: 'staff:all_holders', permission: 'payment.record' },
      mandatory: true,
      title: () => 'Payment needs manual reconciliation',
      message: ({ reference, reason }) =>
        `A Paystack payment (${reference}) matches no XPro payment and was quarantined. ${reason}`,
      link: () => '/admin/payments',
    },
  ),
  // new message: not in spec (05 §8 asks for a dead-letter alert)
  'gateway.event_dead_lettered': entry<{ event: string; reference: string }>({
    key: 'gateway.event_dead_lettered',
    audience: { kind: 'staff:all_holders', permission: 'payment.record' },
    mandatory: true,
    title: () => 'Payment event could not be processed',
    message: ({ event, reference }) =>
      `Paystack event ${event} (${reference}) failed after repeated attempts. Reconcile it manually.`,
    link: () => '/admin/payments',
  }),
  'schedule.proposed_customer': entry<
    RequestParams & { startAt: string; endAt: string }
  >({
    key: 'schedule.proposed_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Schedule proposed',
    message: ({ startAt, endAt }) => `${startAt}–${endAt} WAT. Please confirm.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.proposed_provider': entry<
    RequestParams & { startAt: string; endAt: string }
  >({
    key: 'schedule.proposed_provider',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Schedule proposed',
    message: ({ startAt, endAt }) => `${startAt}–${endAt} WAT. Please confirm.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.confirmed_customer': entry<RequestParams>({
    key: 'schedule.confirmed_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Schedule confirmed',
    message: () => 'Your schedule is confirmed.',
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.confirmed_provider': entry<RequestParams>({
    key: 'schedule.confirmed_provider',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Schedule confirmed',
    message: () =>
      'Your schedule is confirmed. The site address and access details are now in the job.',
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.response_recorded': entry<RequestParams>({
    key: 'schedule.response_recorded',
    audience: { kind: 'staff:holders', permission: 'schedule.manage' },
    mandatory: false,
    title: () => 'Schedule response recorded',
    message: ({ requestCode }) =>
      `${requestCode}: a schedule response was recorded.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.change_requested': entry<RequestParams>({
    key: 'schedule.change_requested',
    audience: { kind: 'staff:holders', permission: 'schedule.manage' },
    mandatory: false,
    title: () => 'Schedule change requested',
    message: ({ requestCode }) =>
      `${requestCode}: a schedule change was requested.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'schedule.reschedule_requested': entry<RequestParams>({
    key: 'schedule.reschedule_requested',
    audience: { kind: 'staff:holders', permission: 'schedule.manage' },
    mandatory: false,
    title: () => 'Reschedule requested',
    message: ({ requestCode }) => `${requestCode}: a reschedule was requested.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'schedule.reminder': entry<RequestParams>({
    key: 'schedule.reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Schedule reminder',
    message: ({ requestCode }) =>
      `${requestCode}: please confirm the proposed schedule.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'schedule.prestart24h': entry<RequestParams>({
    key: 'schedule.prestart24h',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Job starts tomorrow',
    message: ({ requestCode }) =>
      `${requestCode}: your scheduled job starts in 24 hours.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'schedule.prestart2h': entry<RequestParams>({
    key: 'schedule.prestart2h',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'Job starts soon',
    message: ({ requestCode }) =>
      `${requestCode}: your scheduled job starts in 2 hours.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'schedule.staff_followup': entry<RequestParams>({
    key: 'schedule.staff_followup',
    audience: { kind: 'staff:holders', permission: 'schedule.manage' },
    mandatory: false,
    title: () => 'Schedule needs follow-up',
    message: ({ requestCode }) =>
      `${requestCode}: the proposed schedule needs staff follow-up.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'request.on_hold': entry<RequestParams & { reason: string }>({
    key: 'request.on_hold',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Job paused by XPro',
    message: ({ reason }) => reason,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'request.hold_released': entry<RequestParams>({
    key: 'request.hold_released',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Work resumed',
    message: ({ requestCode }) => `${requestCode}: work may resume.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'request.on_hold_customer': entry<RequestParams & { note: string }>({
    key: 'request.on_hold_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Work paused',
    message: ({ note }) => note,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'request.hold_released_customer': entry<RequestParams>({
    key: 'request.hold_released_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Work resumed',
    message: ({ requestCode }) => `${requestCode}: work has resumed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'request.closed': entry<RequestParams>({
    key: 'request.closed',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Job closed',
    message: ({ requestCode }) => `${requestCode}: the job has been closed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'noshow.under_review': entry<RequestParams>({
    key: 'noshow.under_review',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'Attendance under review',
    message: ({ requestCode }) => `${requestCode}: attendance is under review.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'noshow.confirmed': entry<RequestParams>({
    key: 'noshow.confirmed',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'No-show review decision',
    message: ({ requestCode }) =>
      `${requestCode}: the no-show report was confirmed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'noshow.dismissed': entry<RequestParams>({
    key: 'noshow.dismissed',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'No-show review closed',
    message: ({ requestCode }) =>
      `${requestCode}: the no-show report was dismissed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'noshow.investigate': entry<RequestParams>({
    key: 'noshow.investigate',
    audience: { kind: 'staff:holders', permission: 'dispatch.manage' },
    mandatory: false,
    title: () => 'Attendance needs review',
    message: ({ requestCode }) =>
      `${requestCode}: check whether the provider attended.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'completion.acknowledged': entry<RequestParams>({
    key: 'completion.acknowledged',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Job completion confirmed',
    message: ({ requestCode }) =>
      `${requestCode}: the customer confirmed completion.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'completion.reminder': entry<RequestParams>({
    key: 'completion.reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Please confirm your job is complete',
    message: ({ requestCode }) =>
      `${requestCode}: please review the completion report and respond.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'completion.auto_confirmed': entry<RequestParams>({
    key: 'completion.auto_confirmed',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Job completion confirmed automatically',
    message: ({ requestCode }) =>
      `${requestCode}: no response was received, so completion was confirmed automatically.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'issue.raised': entry<RequestParams>({
    key: 'issue.raised',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'XPro is reviewing an issue',
    message: ({ requestCode }) =>
      `${requestCode}: the customer reported an issue. XPro is reviewing it.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'issue.rework_accepted': entry<RequestParams>({
    key: 'issue.rework_accepted',
    audience: { kind: 'provider:current' },
    mandatory: true,
    title: () => 'Rework approved',
    message: ({ requestCode }) =>
      `${requestCode}: XPro approved rework. You can submit a rework update.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.review_needed': entry<RequestParams>({
    key: 'progress.review_needed',
    audience: { kind: 'staff:holders', permission: 'progress.review' },
    mandatory: false,
    title: () => 'Progress update — approval needed',
    message: ({ requestCode }) =>
      `${requestCode}: a provider progress update needs review.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.blocker_needed': entry<RequestParams>({
    key: 'progress.blocker_needed',
    audience: { kind: 'staff:holders', permission: 'progress.review' },
    mandatory: false,
    title: () => 'Blocker reported — urgent review',
    message: ({ requestCode }) =>
      `${requestCode}: a provider reported a blocker that needs urgent review.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.completion_needed': entry<RequestParams>({
    key: 'progress.completion_needed',
    audience: { kind: 'staff:holders', permission: 'progress.review' },
    mandatory: false,
    title: () => 'Completion report — approval needed',
    message: ({ requestCode }) =>
      `${requestCode}: a completion report needs review.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.started': entry<RequestParams>({
    key: 'progress.started',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Work started',
    message: ({ requestCode }) => `${requestCode}: work has started.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.blocker_approved': entry<RequestParams>({
    key: 'progress.blocker_approved',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Work paused',
    message: () => 'Your provider reported a problem. XPro is handling it.',
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'progress.resumed': entry<RequestParams>({
    key: 'progress.resumed',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Work resumed',
    message: ({ requestCode }) => `${requestCode}: work has resumed.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'progress.completion_approved': entry<RequestParams>({
    key: 'progress.completion_approved',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Please confirm your job is complete',
    message: ({ requestCode }) =>
      `${requestCode}: review the evidence and confirm completion.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'progress.on_behalf': entry<RequestParams>({
    key: 'progress.on_behalf',
    audience: { kind: 'provider:current' },
    mandatory: false,
    title: () => 'XPro recorded an update for you',
    message: ({ requestCode }) =>
      `${requestCode}: XPro recorded a progress update on your behalf.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'progress.stale': entry<RequestParams>({
    key: 'progress.stale',
    audience: { kind: 'staff:holders', permission: 'progress.review' },
    mandatory: false,
    title: () => 'Progress update overdue',
    message: ({ requestCode }) =>
      `${requestCode}: no recent progress update was recorded.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'progress.hold_review': entry<RequestParams>({
    key: 'progress.hold_review',
    audience: { kind: 'staff:holders', permission: 'progress.review' },
    mandatory: false,
    title: () => 'Held job needs review',
    message: ({ requestCode }) =>
      `${requestCode}: review the job hold and decide whether work can resume.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'cancellation.requested': entry<RequestParams>({
    key: 'cancellation.requested',
    audience: { kind: 'staff:holders', permission: 'request.cancel' },
    mandatory: false,
    title: () => 'Cancellation request',
    message: ({ requestCode }) =>
      `${requestCode}: the customer requested cancellation.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'cancellation.rejected': entry<RequestParams>({
    key: 'cancellation.rejected',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Cancellation request declined',
    message: ({ requestCode }) =>
      `${requestCode}: XPro declined your cancellation request.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  'cancellation.approved': entry<RequestParams>({
    key: 'cancellation.approved',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Cancellation approved',
    message: ({ requestCode }) =>
      `${requestCode}: your cancellation was approved.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec (05 §9 names "Refund requested" for Finance, not its body)
  'refund.requested': entry<RequestParams & { amount: number }>({
    key: 'refund.requested',
    audience: { kind: 'staff:holders', permission: 'refund.manage' },
    mandatory: true,
    title: () => 'Refund to decide',
    message: ({ requestCode, amount }) =>
      `${requestCode}: a refund of ₦${naira(amount)} is waiting for a decision.`,
    link: () => '/admin/approvals',
  }),
  // new message: not in spec (05 §6.4: a rejected refund needs a new valid decision)
  'refund.rejected': entry<RequestParams>({
    key: 'refund.rejected',
    audience: { kind: 'staff:holders', permission: 'refund.manage' },
    mandatory: true,
    title: () => 'Refund rejected',
    message: ({ requestCode }) =>
      `${requestCode}: the refund was rejected. Request a new refund to finish the cancellation.`,
    link: () => '/admin/approvals',
  }),
  // new message: not in spec (05 §6.4: a gateway failure leaves a Finance item)
  'refund.failed': entry<RequestParams & { amount: number; detail: string }>({
    key: 'refund.failed',
    audience: { kind: 'staff:all_holders', permission: 'refund.manage' },
    mandatory: true,
    title: () => 'Refund needs attention',
    message: ({ requestCode, amount, detail }) =>
      `${requestCode}: the refund of ₦${naira(amount)} did not complete. ${detail} Check it and retry.`,
    link: () => '/admin/approvals',
  }),
  // new message: not in spec (05 §9 names "Payout paid" for the provider, not its body)
  'payout.paid': entry<PayoutProviderParams & { amount: number }>({
    key: 'payout.paid',
    audience: { kind: 'provider:assignment' },
    mandatory: true,
    title: () => 'Payout sent',
    message: ({ requestCode, amount }) =>
      `${requestCode}: your payout of ₦${naira(amount)} has been sent to your bank account.`,
    link: () => '/earnings',
  }),
  // new message: not in spec (05 §9 names "Payout failed" for the provider, not its body)
  'payout.failed': entry<PayoutProviderParams>({
    key: 'payout.failed',
    audience: { kind: 'provider:assignment' },
    mandatory: true,
    title: () => 'Payout delayed',
    message: ({ requestCode }) =>
      `${requestCode}: your payout could not be completed yet. XPro Finance is looking into it.`,
    link: () => '/earnings',
  }),
  // new message: not in spec (05 §9 names "Payout reversed" for the provider, not its body)
  'payout.reversed': entry<PayoutProviderParams & { amount: number }>({
    key: 'payout.reversed',
    audience: { kind: 'provider:assignment' },
    mandatory: true,
    title: () => 'Payout returned',
    message: ({ requestCode, amount }) =>
      `${requestCode}: your payout of ₦${naira(amount)} was returned by the bank. XPro Finance will contact you.`,
    link: () => '/earnings',
  }),
  // new message: not in spec (05 §9 lists Finance and the owner for paid/failed/reversed)
  'payout.finance_update': entry<
    RequestParams & {
      amount: number;
      outcome: 'paid' | 'failed' | 'reversed';
    }
  >({
    key: 'payout.finance_update',
    audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
    mandatory: true,
    title: ({ outcome }) =>
      outcome === 'paid'
        ? 'Payout paid'
        : outcome === 'failed'
          ? 'Payout failed'
          : 'Payout reversed',
    message: ({ requestCode, amount, outcome }) =>
      `${requestCode}: the payout of ₦${naira(amount)} ${
        outcome === 'paid'
          ? 'was paid.'
          : outcome === 'failed'
            ? 'failed. Check it and retry.'
            : 'was reversed. Check it and retry.'
      }`,
    link: () => '/admin/payouts',
  }),
  // new message: not in spec (05 §6.6 asks for urgent Finance review of a transfer that cannot be stopped)
  'payout.needs_attention': entry<
    RequestParams & { amount: number; detail: string }
  >({
    key: 'payout.needs_attention',
    audience: { kind: 'staff:all_holders', permission: 'payout.approve' },
    mandatory: true,
    title: () => 'Payout needs attention',
    message: ({ requestCode, amount, detail }) =>
      `${requestCode}: the payout of ₦${naira(amount)} needs a Finance check. ${detail}`,
    link: () => '/admin/payouts',
  }),
  // new message: not in spec (04 §6.21 gives the transition, not the copy)
  'cancellation.completed_customer': entry<RequestParams>({
    key: 'cancellation.completed_customer',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Request cancelled',
    message: ({ requestCode }) =>
      `${requestCode}: your cancellation is complete.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec (04 §6.21 gives the transition, not the copy)
  'cancellation.completed_provider': entry<
    RequestParams & { assignmentId: string; providerUserId: string }
  >({
    key: 'cancellation.completed_provider',
    audience: { kind: 'provider:assignment' },
    mandatory: true,
    title: () => 'Request cancelled',
    message: ({ requestCode }) =>
      `${requestCode}: this request was cancelled. You no longer have access to it.`,
    link: () => null,
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
