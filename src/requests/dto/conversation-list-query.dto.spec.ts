import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConversationListQueryDto } from './conversation-list-query.dto';

async function parse(plain: Record<string, unknown>) {
  const dto = plainToInstance(ConversationListQueryDto, plain);
  return { dto, errors: await validate(dto) };
}

describe('ConversationListQueryDto', () => {
  it('defaults the limit to 25', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toEqual([]);
    expect(dto.limit).toBe(25);
    expect(dto.status).toBeUndefined();
  });

  it('accepts one status or a repeated status as a list', async () => {
    const single = await parse({ status: 'quoted' });
    expect(single.errors).toEqual([]);
    expect(single.dto.status).toEqual(['quoted']);
    const several = await parse({ status: ['quoted', 'closed'] });
    expect(several.errors).toEqual([]);
    expect(several.dto.status).toEqual(['quoted', 'closed']);
  });

  it('treats an empty status as none', async () => {
    const { dto, errors } = await parse({ status: '' });
    expect(errors).toEqual([]);
    expect(dto.status).toBeUndefined();
  });

  it('rejects an unknown status, alone or in a list', async () => {
    expect((await parse({ status: 'nope' })).errors).toHaveLength(1);
    expect((await parse({ status: ['quoted', 'nope'] })).errors).toHaveLength(
      1,
    );
  });

  it('accepts every request status', async () => {
    const all = [
      'submitted',
      'under_review',
      'matched',
      'quoted',
      'awaiting_payment',
      'ready_to_schedule',
      'scheduled',
      'in_progress',
      'blocked',
      'completion_pending',
      'acknowledged',
      'cancelling',
      'closed',
      'cancelled',
      'rejected',
    ];
    expect((await parse({ status: all })).errors).toEqual([]);
  });

  it('trims q and limits it to 100 characters', async () => {
    const trimmed = await parse({ q: '  roof  ' });
    expect(trimmed.errors).toEqual([]);
    expect(trimmed.dto.q).toBe('roof');
    expect((await parse({ q: 'a'.repeat(100) })).errors).toEqual([]);
    expect((await parse({ q: 'a'.repeat(101) })).errors).toHaveLength(1);
  });

  it('accepts limits 1 to 50 and rejects the rest', async () => {
    expect((await parse({ limit: '1' })).dto.limit).toBe(1);
    expect((await parse({ limit: '50' })).errors).toEqual([]);
    for (const limit of ['0', '51', '-1', '2.5', 'abc'])
      expect((await parse({ limit })).errors).toHaveLength(1);
  });

  it('keeps an opaque cursor string', async () => {
    const { dto, errors } = await parse({ cursor: 'abc_DEF-123' });
    expect(errors).toEqual([]);
    expect(dto.cursor).toBe('abc_DEF-123');
    expect((await parse({ cursor: 'x'.repeat(201) })).errors).toHaveLength(1);
  });
});
