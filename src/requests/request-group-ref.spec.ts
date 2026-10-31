import {
  resolveRequestGroup,
  type RequestGroupRefDb,
} from './request-group-ref';

const UUID = '3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f';
const GROUP = { id: UUID, ref: 'XPG-00007', title: 'Bathroom', ownerId: 'c1' };

function dbWith(rows = [GROUP]) {
  const findUnique = jest.fn(
    ({ where }: { where: { id?: string; ref?: string } }) =>
      Promise.resolve(
        rows.find((row) =>
          where.ref !== undefined ? row.ref === where.ref : row.id === where.id,
        ) ?? null,
      ),
  );
  return {
    db: { requestGroup: { findUnique } } as unknown as RequestGroupRefDb,
    findUnique,
  };
}

describe('resolveRequestGroup', () => {
  it('resolves an XPG reference by ref', async () => {
    const { db, findUnique } = dbWith();
    await expect(resolveRequestGroup(db, 'XPG-00007')).resolves.toEqual(GROUP);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ref: 'XPG-00007' } }),
    );
  });

  it('resolves a uuid by id', async () => {
    const { db, findUnique } = dbWith();
    await expect(resolveRequestGroup(db, UUID)).resolves.toEqual(GROUP);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: UUID } }),
    );
  });

  it('returns null for an unknown group and never queries a malformed reference', async () => {
    const { db, findUnique } = dbWith();
    await expect(resolveRequestGroup(db, 'XPG-00099')).resolves.toBeNull();
    await expect(
      resolveRequestGroup(db, '4f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f'),
    ).resolves.toBeNull();
    findUnique.mockClear();
    for (const bad of ['', 'XPG-1', 'XPR-00007', 'xpg-00007', 'not-a-group']) {
      await expect(resolveRequestGroup(db, bad)).resolves.toBeNull();
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});
