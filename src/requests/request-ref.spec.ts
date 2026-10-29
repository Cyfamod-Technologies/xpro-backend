import { resolveRequestId, type RequestRefDb } from './request-ref';

const UUID = '3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f';

function dbWith(rows: Array<{ id: string; number: number }>) {
  const findUnique = jest.fn(
    ({ where }: { where: { id?: string; number?: number } }) =>
      Promise.resolve(
        rows.find((r) =>
          where.number !== undefined
            ? r.number === where.number
            : r.id === where.id,
        ) ?? null,
      ),
  );
  return {
    db: { serviceRequest: { findUnique } } as unknown as RequestRefDb,
    findUnique,
  };
}

describe('resolveRequestId', () => {
  const rows = [{ id: UUID, number: 42 }];

  it('resolves an XPR reference by number', async () => {
    const { db, findUnique } = dbWith(rows);
    await expect(resolveRequestId(db, 'XPR-00042')).resolves.toBe(UUID);
    expect(findUnique).toHaveBeenCalledWith({
      where: { number: 42 },
      select: { id: true },
    });
  });

  it('resolves a uuid by id', async () => {
    const { db, findUnique } = dbWith(rows);
    await expect(resolveRequestId(db, UUID)).resolves.toBe(UUID);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { id: true },
    });
  });

  it('accepts an upper-case uuid', async () => {
    const { db } = dbWith([{ id: UUID.toUpperCase(), number: 42 }]);
    await expect(resolveRequestId(db, UUID.toUpperCase())).resolves.toBe(
      UUID.toUpperCase(),
    );
  });

  it('returns null for unknown references', async () => {
    const { db } = dbWith(rows);
    await expect(resolveRequestId(db, 'XPR-00099')).resolves.toBeNull();
    await expect(
      resolveRequestId(db, '9f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f'),
    ).resolves.toBeNull();
  });

  it.each([
    '',
    'xpr-00042',
    'XPR-42',
    'XPR-0000x',
    '42',
    'not-a-uuid',
    UUID + 'x',
  ])(
    'returns null for malformed reference %p without querying',
    async (ref) => {
      const { db, findUnique } = dbWith(rows);
      await expect(resolveRequestId(db, ref)).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    },
  );
});
