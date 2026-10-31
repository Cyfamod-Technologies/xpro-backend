export const OPEN_REQUEST_LIMIT_SETTING = 'request.maxOpenPerCustomer';
export const DEFAULT_MAX_OPEN_REQUESTS = 3;

export type OpenRequestAllowance = {
  limit: number;
  open: number;
  remaining: number;
};

export type OpenRequestLimitRefusal = {
  code: 'OPEN_REQUEST_LIMIT';
  message: string;
  details: OpenRequestAllowance;
};

export type OpenRequestLimitResult = { ok: true } | OpenRequestLimitRefusal;

/** The platform limit from the settings snapshot, falling back to the registry default if it is missing or malformed. */
export function platformOpenRequestLimit(
  settings: Readonly<Record<string, unknown>>,
): number {
  const value = settings[OPEN_REQUEST_LIMIT_SETTING];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_OPEN_REQUESTS;
}

export function openRequestAllowance(input: {
  open: number;
  override: number | null;
  settings: Readonly<Record<string, unknown>>;
}): OpenRequestAllowance {
  const limit = input.override ?? platformOpenRequestLimit(input.settings);
  return {
    limit,
    open: input.open,
    remaining: Math.max(0, limit - input.open),
  };
}

/**
 * 04 §6.2: a submission creating `requested` requests is refused when that is
 * more than the owner has left. `open` counts requests that are not closed,
 * cancelled or rejected.
 */
export function evaluateOpenRequestLimit(input: {
  open: number;
  limit: number;
  requested: number;
}): OpenRequestLimitResult {
  const { open, limit, requested } = input;
  const remaining = Math.max(0, limit - open);
  if (requested <= remaining) return { ok: true };
  const details = { limit, open, remaining };
  if (remaining === 0)
    return {
      code: 'OPEN_REQUEST_LIMIT',
      message:
        limit === 1
          ? 'You already have an open request. Wait for it to finish, or cancel it, before sending another.'
          : `You already have ${open} open requests, the most XPro allows at a time. Wait for one to finish, or cancel one, before sending another.`,
      details,
    };
  const excess = requested - remaining;
  return {
    code: 'OPEN_REQUEST_LIMIT',
    message: `You can have ${limit} open ${limit === 1 ? 'request' : 'requests'} at a time and you have ${open}. Remove ${excess} ${excess === 1 ? 'service' : 'services'} from this submission, or finish an open request first.`,
    details,
  };
}
