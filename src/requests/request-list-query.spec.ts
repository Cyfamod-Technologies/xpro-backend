import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppError } from '../platform/errors/app-error';
import {
  REQUEST_SORTS,
  RequestListQueryDto,
} from './dto/request-list-query.dto';
import { activityCountSql, activityRowsSql } from './request-activity.query';
import {
  listOrderBy,
  OWNER_FILTER_MESSAGE,
  ownerFilter,
} from './request-list-query';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

describe('ownerFilter', () => {
  it('adds no condition for all or when absent', () => {
    expect(ownerFilter('all', ACTOR)).toBeNull();
    expect(ownerFilter(undefined, ACTOR)).toBeNull();
  });

  it('maps mine to the actor and unclaimed to null on staffOwnerId', () => {
    expect(ownerFilter('mine', ACTOR)).toEqual({ staffOwnerId: ACTOR });
    expect(ownerFilter('unclaimed', ACTOR)).toEqual({ staffOwnerId: null });
  });

  it('maps a staff id to staffOwnerId, never the customer column', () => {
    expect(ownerFilter(STAFF, ACTOR)).toEqual({ staffOwnerId: STAFF });
  });

  it.each(['someone', 'XPR-00001', '1234', 'ALL', ''])(
    'rejects %p with 422 VALIDATION_ERROR',
    (value) => {
      let error: unknown;
      try {
        ownerFilter(value, ACTOR);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(422);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
      expect((error as AppError).message).toBe(OWNER_FILTER_MESSAGE);
    },
  );
});

describe('sort whitelist', () => {
  const check = (sort: unknown) =>
    validate(plainToInstance(RequestListQueryDto, { sort }));

  it.each(REQUEST_SORTS)('accepts %s', async (sort) => {
    expect(await check(sort)).toHaveLength(0);
  });

  it.each([
    'createdAt',
    'title:asc',
    'createdAt:desc; DROP TABLE x',
    'id:desc',
  ])('rejects %p', async (sort) => {
    const errors = await check(sort);
    expect(errors.map((error) => error.property)).toEqual(['sort']);
  });

  it('defaults to newest created first, with id as the tiebreak', () => {
    expect(listOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it.each([
    ['createdAt:desc', [{ createdAt: 'desc' }, { id: 'desc' }]],
    ['createdAt:asc', [{ createdAt: 'asc' }, { id: 'asc' }]],
    ['updatedAt:desc', [{ updatedAt: 'desc' }, { id: 'desc' }]],
    ['id:asc', [{ id: 'asc' }]],
  ] as const)('orders by %s', (sort, expected) => {
    expect(listOrderBy(sort)).toEqual(expected);
  });
});

describe('activity queries', () => {
  const REQUEST = '33333333-3333-4333-8333-333333333333';

  it('filters on metadata requestId with a bound parameter, newest first', () => {
    const query = activityRowsSql(REQUEST, 20, 20);
    expect(query.sql).toContain("WHERE metadata->>'requestId' = ?");
    expect(query.sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(query.sql).not.toContain(REQUEST);
    expect(query.values).toEqual([REQUEST, 20, 20]);
  });

  it('counts the same rows', () => {
    const query = activityCountSql(REQUEST);
    expect(query.sql).toContain("WHERE metadata->>'requestId' = ?");
    expect(query.values).toEqual([REQUEST]);
  });
});
