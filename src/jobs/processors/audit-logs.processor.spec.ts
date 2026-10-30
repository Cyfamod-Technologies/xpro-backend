import { buildPublicId } from './audit-logs.processor';

describe('buildPublicId', () => {
  const moment = new Date('2026-10-30T02:15:09.000Z');

  it('keeps the dated prefix and adds a suffix', () => {
    expect(buildPublicId(moment)).toMatch(/^AUD-\d{6}-\d{6}-[0-9a-f]{6}$/);
  });

  it('gives different ids to events in the same second', () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => buildPublicId(moment)),
    );

    expect(ids.size).toBe(500);
  });
});
