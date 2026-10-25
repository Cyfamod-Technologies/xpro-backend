export type ChangeRequestParty = 'customer' | 'provider';

/** Plan §D.2 `schedules.change_requests` entry. */
export type StoredChangeRequest = {
  by: ChangeRequestParty;
  note: string;
  at: string;
  handledAt: string | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

/**
 * Reads `change_requests` in the §D.2 shape `{ by, note, at, handledAt }`. Rows
 * written before the shape was aligned used `{ party, createdAt, urgent }` and
 * may lack `handledAt`; those keys are mapped and a missing `handledAt` is open.
 */
export function readChangeRequests(raw: unknown): StoredChangeRequest[] {
  if (!Array.isArray(raw)) return [];
  const result: StoredChangeRequest[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const by = item.by ?? item.party;
    if (by !== 'customer' && by !== 'provider') continue;
    result.push({
      by,
      note: text(item.note) ?? '',
      at: text(item.at) ?? text(item.createdAt) ?? '',
      handledAt: text(item.handledAt),
    });
  }
  return result;
}

export const hasOpenChangeRequest = (
  raw: unknown,
  party: ChangeRequestParty,
): boolean =>
  readChangeRequests(raw).some((item) => item.by === party && !item.handledAt);

export const appendChangeRequest = (
  raw: unknown,
  request: { by: ChangeRequestParty; note: string; at: Date },
): StoredChangeRequest[] => [
  ...readChangeRequests(raw),
  {
    by: request.by,
    note: request.note,
    at: request.at.toISOString(),
    handledAt: null,
  },
];

/** 04 §6.13 propose effects: staff proposing a new date handles every open request. */
export const markChangeRequestsHandled = (
  raw: unknown,
  now: Date,
): StoredChangeRequest[] =>
  readChangeRequests(raw).map((item) => ({
    ...item,
    handledAt: item.handledAt ?? now.toISOString(),
  }));
