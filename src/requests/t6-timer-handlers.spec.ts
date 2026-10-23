import type { RequestTimer } from '@prisma/client';
import { OutboxService } from '../platform/outbox/outbox.service';
import { TimersService } from '../platform/timers/timers.service';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { T6TimerHandlers } from './t6-timer-handlers';

describe('T6 clarification timer handlers', () => {
  it('auto-cancels only the still-current clarification and records the required effects', async () => {
    const askedAt = new Date('2026-10-01T10:00:00.000Z');
    const request = {
      id: 'request-42', number: 42, ownerId: 'customer-1', status: 'submitted',
      intakeState: 'clarification', clarificationAskedAt: askedAt,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: request.id }]),
      serviceRequest: { findUnique: jest.fn().mockResolvedValue(request), update: jest.fn() },
      cancellation: { create: jest.fn().mockResolvedValue({ id: 'cancel-1' }) },
      requestMessage: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      serviceRequest: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx)),
    };
    const notifications = { dispatch: jest.fn() };
    const timers = { stop: jest.fn() };
    const outbox = { kick: jest.fn() };
    const registry = new TimerRegistry();
    new T6TimerHandlers(
      registry,
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationDispatcher,
      timers as unknown as TimersService,
      outbox as unknown as OutboxService,
    );
    const timer = {
      id: 'timer-1', requestId: request.id, kind: TimerKinds.T6AutoCancel,
      payload: { clarificationAskedAt: askedAt.toISOString() },
    } as RequestTimer;
    const handler = registry.get(TimerKinds.T6AutoCancel);

    await handler?.(timer);

    expect(tx.cancellation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      requestId: request.id, requestedBy: 'system', reasonCode: 'no_response', status: 'completed', stage: 'submitted',
    }) });
    expect(tx.serviceRequest.update).toHaveBeenCalledWith({ where: { id: request.id }, data: { status: 'cancelled', cancellationId: 'cancel-1' } });
    expect(tx.requestMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      requestId: request.id, channel: 'customer', authorRole: 'system', text: "Cancelled: we didn't hear back from you.",
    }) });
    expect(notifications.dispatch).toHaveBeenCalledWith(tx, 'request.auto_cancelled', { requestCode: 'XPR-00042' }, expect.objectContaining({ ownerId: 'customer-1' }));
    expect(timers.stop).toHaveBeenCalledWith(tx, expect.objectContaining({ requestId: request.id }));
    expect(outbox.kick).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the clarification was answered before the timer ran', async () => {
    const registry = new TimerRegistry();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'request-42' }]),
      serviceRequest: { findUnique: jest.fn().mockResolvedValue({
        id: 'request-42', number: 42, ownerId: 'customer-1', status: 'submitted',
        intakeState: 'pending', clarificationAskedAt: new Date('2026-10-01T10:00:00.000Z'),
      }), update: jest.fn() },
      cancellation: { create: jest.fn() }, requestMessage: { create: jest.fn() }, auditLog: { create: jest.fn() },
    };
    const prisma = {
      serviceRequest: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx)),
    };
    const notifications = { dispatch: jest.fn() };
    const outbox = { kick: jest.fn() };
    new T6TimerHandlers(registry, prisma as never, notifications as never, { stop: jest.fn() } as never, outbox as never);
    const timer = {
      id: 'timer-1', requestId: 'request-42', kind: TimerKinds.T6AutoCancel,
      payload: { clarificationAskedAt: '2026-10-01T10:00:00.000Z' },
    } as RequestTimer;

    await registry.get(TimerKinds.T6AutoCancel)?.(timer);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(notifications.dispatch).not.toHaveBeenCalled();
    expect(tx.cancellation.create).not.toHaveBeenCalled();
    expect(tx.requestMessage.create).not.toHaveBeenCalled();
    expect(outbox.kick).not.toHaveBeenCalled();
  });
});
