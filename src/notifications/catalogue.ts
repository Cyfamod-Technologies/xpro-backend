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
type QuoteNoticeParams = RequestParams & { note?: string };

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
    RequestParams & { assignmentId: string; service: string; district: string }
  >({
    key: 'request.offer_withdrawn',
    audience: { kind: 'provider:assignment' },
    mandatory: false,
    title: () => 'Offer withdrawn',
    message: ({ service, district }) =>
      `${service} in ${district}: the request changed. XPro may send you a new offer.`,
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
  // new message: not in spec
  'quote.expired': entry<RequestParams>({
    key: 'quote.expired',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Quote expired',
    message: ({ requestCode }) =>
      `${requestCode}: the quote validity window ended. XPro will follow up.`,
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
  // new message: not in spec
  'payment.reminder': entry<RequestParams & { dueDate: string }>({
    key: 'payment.reminder',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Payment due',
    message: ({ requestCode, dueDate }) =>
      `${requestCode}: your payment is due by ${dueDate}.`,
    link: ({ requestCode }) => `/requests/${requestCode}`,
  }),
  // new message: not in spec
  'payment.lapsed': entry<RequestParams>({
    key: 'payment.lapsed',
    audience: { kind: 'customer' },
    mandatory: false,
    title: () => 'Quote expired',
    message: ({ requestCode }) =>
      `${requestCode}: the payment window closed. XPro will send you an updated quote.`,
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
