import type { ActorView, RequestSnapshot } from './snapshot';
import { isCurrentProvider, isOwner } from './guards/common';
import type { DomainGuard } from './guards/types';

const TERMINAL = new Set(['closed', 'cancelled', 'rejected']);

export const canSendMessage: DomainGuard<unknown> = (
  snap: RequestSnapshot,
  actor: ActorView,
  input,
) => {
  if (TERMINAL.has(snap.status))
    return {
      ok: false,
      status: 409,
      code: 'STATE_CONFLICT',
      message: 'Messages are closed for this request.',
    };
  const messageInput = isMessageInput(input) ? input : null;
  if (!messageInput) {
    if (isOwner(snap, actor)) return { ok: true };
    if (isCurrentProvider(snap, actor)) return { ok: true };
    if (
      actor.kind === 'staff' &&
      ['message.customer', 'message.provider', 'message.internal'].some(
        (permission) => actor.permissions?.has(permission),
      )
    )
      return { ok: true };
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Choose a conversation available to your account.',
    };
  }
  if (messageInput.channel === 'customer' && isOwner(snap, actor))
    return { ok: true };
  if (
    messageInput.channel === 'provider' &&
    isCurrentProvider(snap, actor) &&
    snap.accessibleProviderUserIds?.includes(actor.userId ?? '')
  )
    return { ok: true };
  const permission =
    messageInput.channel === 'customer'
      ? 'message.customer'
      : messageInput.channel === 'provider'
        ? 'message.provider'
        : 'message.internal';
  if (actor.kind === 'staff' && actor.permissions?.has(permission))
    return { ok: true };
  return {
    ok: false,
    status: 403,
    code: 'FORBIDDEN',
    message: 'Choose a conversation available to your account.',
  };
};

function isMessageInput(input: unknown): input is {
  channel: 'customer' | 'provider' | 'internal';
  providerId?: string | null;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    'channel' in input &&
    ['customer', 'provider', 'internal'].includes(String(input.channel))
  );
}

export const MESSAGE_GUARDS = { 'message.send': canSendMessage };
