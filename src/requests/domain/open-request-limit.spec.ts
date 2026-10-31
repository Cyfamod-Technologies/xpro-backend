import {
  evaluateOpenRequestLimit,
  openRequestAllowance,
  platformOpenRequestLimit,
} from './open-request-limit';

const LIMIT_ONE =
  'You already have an open request. Wait for it to finish, or cancel it, before sending another.';
const refusal = (open: number, limit: number, requested: number) => {
  const result = evaluateOpenRequestLimit({ open, limit, requested });
  if ('ok' in result) throw new Error('Expected a refusal.');
  return result;
};

describe('evaluateOpenRequestLimit', () => {
  it('accepts a submission that fits in the remaining room, including an exact fit', () => {
    expect(
      evaluateOpenRequestLimit({ open: 0, limit: 3, requested: 1 }),
    ).toEqual({
      ok: true,
    });
    expect(
      evaluateOpenRequestLimit({ open: 1, limit: 3, requested: 2 }),
    ).toEqual({
      ok: true,
    });
    expect(
      evaluateOpenRequestLimit({ open: 0, limit: 1, requested: 1 }),
    ).toEqual({
      ok: true,
    });
  });

  it('refuses at limit 1 with remaining 0 using the single-request message', () => {
    expect(refusal(1, 1, 1)).toEqual({
      code: 'OPEN_REQUEST_LIMIT',
      message: LIMIT_ONE,
      details: { limit: 1, open: 1, remaining: 0 },
    });
  });

  it('refuses with remaining 0 at a larger limit, naming the open count', () => {
    expect(refusal(3, 3, 1)).toEqual({
      code: 'OPEN_REQUEST_LIMIT',
      message:
        'You already have 3 open requests, the most XPro allows at a time. Wait for one to finish, or cancel one, before sending another.',
      details: { limit: 3, open: 3, remaining: 0 },
    });
  });

  it('refuses when some room remains but fewer than requested, singular and plural', () => {
    expect(refusal(2, 3, 2)).toEqual({
      code: 'OPEN_REQUEST_LIMIT',
      message:
        'You can have 3 open requests at a time and you have 2. Remove 1 service from this submission, or finish an open request first.',
      details: { limit: 3, open: 2, remaining: 1 },
    });
    expect(refusal(1, 3, 4).message).toBe(
      'You can have 3 open requests at a time and you have 1. Remove 2 services from this submission, or finish an open request first.',
    );
  });

  it('floors remaining at 0 when the customer is over a lowered limit', () => {
    const result = refusal(5, 3, 1);
    expect(result.details).toEqual({ limit: 3, open: 5, remaining: 0 });
    expect(result.message).toContain('You already have 5 open requests');
  });

  it('uses the singular request for limit 1 with a bundle of two and open 0', () => {
    expect(refusal(0, 1, 2).message).toBe(
      'You can have 1 open request at a time and you have 0. Remove 1 service from this submission, or finish an open request first.',
    );
  });
});

describe('open-request allowance', () => {
  it('lets the override beat the platform setting and computes remaining', () => {
    const settings = { 'request.maxOpenPerCustomer': 3 };
    expect(openRequestAllowance({ open: 1, override: null, settings })).toEqual(
      {
        limit: 3,
        open: 1,
        remaining: 2,
      },
    );
    expect(openRequestAllowance({ open: 1, override: 10, settings })).toEqual({
      limit: 10,
      open: 1,
      remaining: 9,
    });
    expect(
      openRequestAllowance({ open: 4, override: 2, settings }).remaining,
    ).toBe(0);
  });

  it('falls back to 3 when the setting is missing or malformed', () => {
    for (const settings of [
      {},
      { 'request.maxOpenPerCustomer': 'x' },
      { 'request.maxOpenPerCustomer': 0 },
    ])
      expect(platformOpenRequestLimit(settings)).toBe(3);
  });
});
