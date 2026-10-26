import { Prisma } from '@prisma/client';
import { AppError } from '../../platform/errors/app-error';
import { isOverlapViolation, mapOverlapViolation } from './overlap-violation';

const clientVersion = 'test';

describe('schedules_no_confirmed_overlap mapping (04 §6.13, D-04)', () => {
  const unknown = (message: string) =>
    new Prisma.PrismaClientUnknownRequestError(message, { clientVersion });
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
      code,
      clientVersion,
      meta,
    });

  it.each([
    [
      'an unknown request error naming the SQLSTATE',
      unknown('Invalid `prisma.schedule.update()`\n\nCode: `23P01`'),
    ],
    [
      'an unknown request error naming the constraint',
      unknown(
        'conflicting key value violates exclusion constraint "schedules_no_confirmed_overlap"',
      ),
    ],
    [
      'a known error whose meta carries 23P01',
      known('P2010', { code: '23P01', message: 'exclusion violation' }),
    ],
    [
      'a known error whose meta names the constraint',
      known('P2004', { constraint: 'schedules_no_confirmed_overlap' }),
    ],
  ])('detects %s', (_name, error) => {
    expect(isOverlapViolation(error)).toBe(true);
  });

  it.each([
    ['a unique violation', known('P2002', { target: ['number'] })],
    ['an unrelated unknown error', unknown('connection reset')],
    ['a plain error mentioning 23P01', new Error('23P01')],
    ['a non-error', 'schedules_no_confirmed_overlap'],
  ])('ignores %s', (_name, error) => {
    expect(isOverlapViolation(error)).toBe(false);
  });

  it('maps a violation to the second-confirmation 409', () => {
    const mapped = mapOverlapViolation(unknown('Code: `23P01`'));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
      message:
        'This date no longer works for the provider. XPro will propose a new one.',
    });
  });

  it('passes other errors through untouched', () => {
    const other = new Error('boom');
    expect(mapOverlapViolation(other)).toBe(other);
  });
});
