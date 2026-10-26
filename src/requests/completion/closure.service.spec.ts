import type { ActorContext } from '../../platform/actor/actor.types';
import { systemCommandKit } from '../system-command.testkit';
import { ClosureService } from './closure.service';

const staff = {
  userId: 'staff-1',
  kind: 'staff',
  platformRoles: ['staff'],
  staff: {
    status: 'active',
    permissions: new Set(['request.close']),
    isSuperAdmin: false,
  },
} as unknown as ActorContext;

function setup(state: { state: string; reason?: string }) {
  const tx = {
    serviceRequest: { update: jest.fn() },
    assignment: { updateMany: jest.fn() },
    approvalDeadline: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const kit = systemCommandKit({
    tx,
    snap: { status: 'acknowledged', number: 'XPR-00042' },
  });
  const finance = { closureState: jest.fn().mockResolvedValue(state) };
  const actors = { resolve: jest.fn().mockResolvedValue(staff) };
  const service = new ClosureService(
    actors as never,
    kit.runner,
    finance as never,
  );
  return { service, tx, finance, ...kit };
}

const close = (service: ClosureService) =>
  service.close({ id: 'staff-1' } as never, 'XPR-00042', {}, undefined, '/url');

describe('ClosureService.close payout guard (04 §6.17, C-18)', () => {
  it('asks FinanceService.closureState inside the closing transaction', async () => {
    const { service, finance, tx } = setup({ state: 'paid' });

    await close(service);

    expect(finance.closureState).toHaveBeenCalledWith(tx, 'request-1');
  });

  it.each([
    ['paid', { state: 'paid' }],
    ['held with a reason', { state: 'on_hold_with_reason', reason: 'Issue' }],
  ])('closes when the primary payout is %s', async (_name, state) => {
    const { service, tx, effects } = setup(state);

    await close(service);

    expect(tx.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({ status: 'closed' }) as unknown,
    });
    expect(effects.audit[0].action).toBe('Job closed');
  });

  it.each([
    ['No provider payout has been created.'],
    ['A provider payout hold needs a recorded reason.'],
    ['A provider payout is still pending.'],
  ])(
    'refuses to close while the payout is blocked, surfacing "%s"',
    async (reason) => {
      const { service, tx } = setup({ state: 'blocked', reason });

      await expect(close(service)).rejects.toMatchObject({
        status: 409,
        message: reason,
      });
      expect(tx.serviceRequest.update).not.toHaveBeenCalled();
    },
  );

  it('falls back to the generic closure message when no reason is given', async () => {
    const { service } = setup({ state: 'blocked' });

    await expect(close(service)).rejects.toMatchObject({
      status: 409,
      message:
        'A provider payout must be paid or held with a reason before closure.',
    });
  });
});

describe('ClosureService.close approvals (02 §6.11, plan C.5)', () => {
  it('closes every open item for the request except the money items Finance still decides', async () => {
    const { service, tx, effects } = setup({ state: 'paid' });
    tx.approvalDeadline.findMany.mockResolvedValue([
      { kind: 'ready_to_close', itemId: 'request-1' },
      { kind: 'completion_issue', itemId: 'issue-1' },
      { kind: 'payout', itemId: 'payout-1' },
      { kind: 'refund', itemId: 'refund-1' },
    ]);

    await close(service);

    expect(tx.approvalDeadline.findMany).toHaveBeenCalledWith({
      where: { requestId: 'request-1', closedAt: null },
      select: { kind: true, itemId: true },
    });
    expect(effects.approvalCloses).toEqual([
      { kind: 'ready_to_close', itemId: 'request-1', reason: 'request_closed' },
      { kind: 'completion_issue', itemId: 'issue-1', reason: 'request_closed' },
    ]);
  });
});
