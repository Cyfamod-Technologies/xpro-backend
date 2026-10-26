import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RaiseIssueDto } from '../completion/issues.dto';
import { CompletionResponseDto } from '../completion/completion.dto';
import { AddProgressDto, AddProgressOnBehalfDto } from './progress.dto';
import { RecordNoShowDto } from './noshow.dto';

const check = async <T extends object>(
  type: new () => T,
  body: Record<string, unknown>,
) => {
  const instance = plainToInstance(type, body);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, errors };
};

describe('nested { id } attachments (D-23, E-07)', () => {
  const update = { status: 'in_progress', note: 'Tiles laid.' };

  it.each([
    ['AddProgressDto', AddProgressDto, update],
    [
      'AddProgressOnBehalfDto',
      AddProgressOnBehalfDto,
      { ...update, reportedVia: 'Phone call' },
    ],
  ] as const)('%s accepts [{ id }] and maps it', async (_name, type, body) => {
    const { instance, errors } = await check(type as never, {
      ...body,
      attachments: [{ id: 'f1' }, { id: 'f2' }],
    });
    expect(errors).toEqual([]);
    expect(
      (instance as { attachments: Array<{ id: string }> }).attachments.map(
        ({ id }) => id,
      ),
    ).toEqual(['f1', 'f2']);
  });

  it.each([
    ['AddProgressDto', AddProgressDto, update],
    [
      'AddProgressOnBehalfDto',
      AddProgressOnBehalfDto,
      { ...update, reportedVia: 'Phone call' },
    ],
  ] as const)('%s refuses a bare string array', async (_name, type, body) => {
    const { errors } = await check(type as never, {
      ...body,
      attachments: ['f1'],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('defaults to no attachments and caps them at six', async () => {
    const none = await check(AddProgressDto, update);
    expect(none.errors).toEqual([]);
    expect(none.instance.attachments).toEqual([]);
    const seven = await check(AddProgressDto, {
      ...update,
      attachments: Array.from({ length: 7 }, (_, index) => ({
        id: `f${index}`,
      })),
    });
    expect(seven.errors.length).toBeGreaterThan(0);
  });

  it('leaves the note and reporting channel to the spec messages', async () => {
    const { errors } = await check(AddProgressOnBehalfDto, {
      status: 'in_progress',
      note: 'x',
      reportedVia: '',
    });
    expect(errors).toEqual([]);
  });

  it('completion.respond and issue.raise accept [{ id }]', async () => {
    const completion = await check(CompletionResponseDto, {
      acknowledge: false,
      note: 'Cracked tiles.',
      attachments: [{ id: 'f1' }],
    });
    expect(completion.errors).toEqual([]);
    const raised = await check(RaiseIssueDto, {
      note: 'Leak is back.',
      attachments: [{ id: 'f1' }],
    });
    expect(raised.errors).toEqual([]);
    const bare = await check(RaiseIssueDto, {
      note: 'Leak is back.',
      attachments: ['f1'],
    });
    expect(bare.errors.length).toBeGreaterThan(0);
  });

  it('noshow.record keeps evidenceIds as upload ids', async () => {
    const ok = await check(RecordNoShowDto, {
      scheduleId: 's1',
      note: 'Nobody came to site.',
      evidenceIds: ['u1', 'u2'],
    });
    expect(ok.errors).toEqual([]);
    const nested = await check(RecordNoShowDto, {
      scheduleId: 's1',
      note: 'Nobody came to site.',
      evidenceIds: [{ id: 'u1' }],
    });
    expect(nested.errors.length).toBeGreaterThan(0);
  });
});
