import type { StaffPermission } from '../staff/staff-permissions';

export type NotificationAudience =
  | { kind: 'customer' }
  | { kind: 'provider:current' }
  | { kind: 'provider:assignment' }
  | { kind: 'staff:gated'; permission: StaffPermission }
  | { kind: 'staff:info' }
  | { kind: 'staff:pricing' }
  | { kind: 'staff:holders'; permission: StaffPermission };

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
  'request.clarification_requested': entry<RequestParams>({
    key: 'request.clarification_requested',
    audience: { kind: 'customer' },
    mandatory: true,
    title: () => 'Clarification requested',
    // new message: not in spec
    message: ({ requestCode }) =>
      `XPro Team has a question about ${requestCode}. Open your messages to reply.`,
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
