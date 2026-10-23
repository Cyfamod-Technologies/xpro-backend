export function formatEtag(version: number): string {
  return `W/"${version}"`;
}

/** Accepts `W/"<n>"` or `"<n>"`; returns null for anything else. */
export function parseEtag(value: string): number | null {
  const match = /^(?:W\/)?"(\d{1,15})"$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}
