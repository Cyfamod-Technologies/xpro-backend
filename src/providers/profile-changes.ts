type Snapshot = {
  trade: string;
  services: unknown;
  serviceIds?: unknown;
  serviceAreaIds?: unknown;
  skills: unknown;
  skillIds?: unknown;
  capacity: number;
  documents: unknown;
  photo: unknown;
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const idOf = (item: unknown) =>
  typeof item === 'string'
    ? item
    : item && typeof item === 'object' && 'id' in item
      ? String(item.id)
      : '';
const ids = (value: unknown) => list(value).map(idOf).filter(Boolean).sort();
const names = (value: unknown) =>
  list(value)
    .map((item) => String(item).trim().toLowerCase())
    .sort();
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);
const grouped = (value: unknown) =>
  JSON.stringify(
    Object.entries(
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    )
      .map(([key, items]) => [key, list(items).map(String).sort()] as const)
      .filter(([, items]) => items.length)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/**
 * The names of the sensitive profile fields a held change would alter, for the review history. Service areas are compared by
 * id. Services and skills are compared by id when both sides have them; older profiles without ids fall back to the saved
 * names.
 */
export function changedProfileFields(
  live: Snapshot,
  proposed: Snapshot,
): string[] {
  const fields: string[] = [];
  const trade = (value: { trade?: string }) => (value.trade ?? '').trim();
  if (trade(live) !== trade(proposed)) fields.push('Trade');
  const bothHaveServiceIds =
    list(live.serviceIds).length > 0 && list(proposed.serviceIds).length > 0;
  const servicesChanged = bothHaveServiceIds
    ? !sameList(ids(live.serviceIds), ids(proposed.serviceIds))
    : !sameList(names(live.services), names(proposed.services));
  if (servicesChanged) fields.push('Services');
  if (!sameList(ids(live.serviceAreaIds), ids(proposed.serviceAreaIds)))
    fields.push('Service areas');
  const skillsChanged = bothHaveServiceIds
    ? grouped(live.skillIds) !== grouped(proposed.skillIds)
    : grouped(live.skills) !== grouped(proposed.skills);
  if (skillsChanged) fields.push('Skills');
  if (live.capacity !== proposed.capacity) fields.push('Job capacity');
  if (!sameList(ids(live.documents), ids(proposed.documents)))
    fields.push('Verification documents');
  if (idOf(live.photo) !== idOf(proposed.photo)) fields.push('Face photo');
  return fields;
}
