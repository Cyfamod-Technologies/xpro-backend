import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import type { RequestUser } from '../common/types/request-user';
import { AdminFinanceController } from './payments.controller';

type ParamEntry = {
  factory: (data: unknown, context: unknown) => unknown;
  data: unknown;
};

/** Runs every custom parameter decorator of a route against a request with these headers. */
function resolveParams(method: keyof AdminFinanceController, headers: object) {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    AdminFinanceController,
    method,
  ) as Record<string, ParamEntry & { index: number }> | undefined;
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers, user: undefined }) }),
  };
  return Object.values(metadata ?? {})
    .filter((entry) => typeof entry.factory === 'function')
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.factory(entry.data, context));
}

const user = { id: 'finance-1' } as RequestUser;
const response = () => {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response,
  };
};
const req = { originalUrl: '/admin/refunds/refund-1/decide' } as Request;

describe('AdminFinanceController (C-46)', () => {
  describe('Idempotency-Key', () => {
    it.each(['decideRefund', 'transferPayout', 'retryPayoutTransfer'] as const)(
      '%s requires the header with the spec message',
      (method) => {
        expect(() => resolveParams(method, {})).toThrow(
          'Idempotency-Key header is required.',
        );
        expect(() =>
          resolveParams(method, { 'idempotency-key': 'key-12345678' }),
        ).not.toThrow();
      },
    );
  });

  describe('If-Match', () => {
    it.each([
      'decideRefund',
      'secondApproveRefund',
      'transferRefund',
      'reconcileRefund',
      'approvePayout',
      'secondApprovePayout',
      'holdPayout',
      'releasePayout',
      'transferPayout',
      'reconcilePayout',
    ] as const)('%s reads an optional If-Match', (method) => {
      const headers = { 'idempotency-key': 'key-12345678' };
      expect(resolveParams(method, headers)).not.toContain(3);
      expect(
        resolveParams(method, { ...headers, 'if-match': 'W/"3"' }),
      ).toContain(3);
      expect(() =>
        resolveParams(method, { ...headers, 'if-match': 'nonsense' }),
      ).toThrow('Refresh the request and try again.');
    });
  });

  describe('ETag', () => {
    const refunds = {
      decide: jest.fn(),
      secondApprove: jest.fn(),
      recordTransfer: jest.fn(),
      reconcile: jest.fn(),
    };
    const finance = {
      approvePayout: jest.fn(),
      secondApprovePayout: jest.fn(),
      payoutHold: jest.fn(),
      transferPayout: jest.fn(),
      reconcilePayout: jest.fn(),
    };
    const controller = new AdminFinanceController(
      finance as never,
      refunds as never,
    );
    const dto = {
      approve: true,
      reason: 'ok',
      note: 'ok since',
      method: 'paystack',
    };

    beforeEach(() => jest.clearAllMocks());

    it('passes If-Match and the idempotency key to the refund decision and returns the new version as the ETag', async () => {
      refunds.decide.mockResolvedValue({ id: 'refund-1', version: 5 });
      const { res, headers } = response();

      const result = await controller.decideRefund(
        user,
        'refund-1',
        dto,
        4,
        'key-12345678',
        req,
        res,
      );

      expect(refunds.decide).toHaveBeenCalledWith(
        'finance-1',
        'refund-1',
        dto,
        { key: 'key-12345678', url: '/admin/refunds/refund-1/decide' },
        4,
      );
      expect(result).toEqual({ id: 'refund-1', version: 5 });
      expect(headers.ETag).toBe('W/"5"');
    });

    it('sends the ETag of every other decision route', async () => {
      refunds.secondApprove.mockResolvedValue({ version: 2 });
      refunds.recordTransfer.mockResolvedValue({ version: 3 });
      refunds.reconcile.mockResolvedValue({ version: 4 });
      finance.approvePayout.mockResolvedValue({ version: 6 });
      finance.secondApprovePayout.mockResolvedValue({ version: 7 });
      finance.payoutHold.mockResolvedValue({ version: 8 });
      finance.reconcilePayout.mockResolvedValue({ version: 9 });
      finance.transferPayout.mockResolvedValue({ version: 10 });
      const sent: string[] = [];
      const run = async (call: (res: Response) => Promise<unknown>) => {
        const { res, headers } = response();
        await call(res);
        sent.push(headers.ETag);
      };

      await run((res) =>
        controller.secondApproveRefund(user, 'r', dto, undefined, res),
      );
      await run((res) =>
        controller.transferRefund(
          user,
          'r',
          { reference: 'R', proofFileId: 'f' },
          undefined,
          res,
        ),
      );
      await run((res) =>
        controller.reconcileRefund(user, 'r', { note: 'note' }, undefined, res),
      );
      await run((res) =>
        controller.approvePayout(user, 'p', {}, undefined, res),
      );
      await run((res) =>
        controller.secondApprovePayout(user, 'p', dto, undefined, res),
      );
      await run((res) =>
        controller.holdPayout(user, 'p', { reason: 'why' }, undefined, res),
      );
      await run((res) =>
        controller.reconcilePayout(user, 'p', { note: 'note' }, undefined, res),
      );
      await run((res) =>
        controller.transferPayout(
          user,
          'p',
          { method: 'paystack' },
          undefined,
          'key-12345678',
          req,
          res,
        ),
      );

      expect(sent).toEqual([
        'W/"2"',
        'W/"3"',
        'W/"4"',
        'W/"6"',
        'W/"7"',
        'W/"8"',
        'W/"9"',
        'W/"10"',
      ]);
    });

    it('sends no ETag for a replayed body that predates the column', async () => {
      refunds.decide.mockResolvedValue({ id: 'refund-1' });
      const { res, headers } = response();

      await controller.decideRefund(
        user,
        'refund-1',
        dto,
        undefined,
        'key-12345678',
        req,
        res,
      );

      expect(headers.ETag).toBeUndefined();
    });
  });
});
