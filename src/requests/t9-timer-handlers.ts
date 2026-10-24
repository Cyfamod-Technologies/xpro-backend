import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OutboxService } from '../platform/outbox/outbox.service';
import { TimersService } from '../platform/timers/timers.service';
import { TimerRegistry } from '../platform/timers/timer-registry';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class T9TimerHandlers {
  constructor(registry: TimerRegistry, private readonly prisma: PrismaService, private readonly timers: TimersService, private readonly notifications: NotificationDispatcher, private readonly outbox: OutboxService, private readonly payments: PaymentsService) {
    registry.register('T9.reminder24h', (timer) => this.remind(timer));
    registry.register('T9.reminder72h', (timer) => this.remind(timer));
    registry.register('T9.lapse', (timer) => this.lapse(timer));
  }

  private async remind(timer: RequestTimer) {
    const row = await this.prisma.quote.findFirst({ where: { id: timer.refId, requestId: timer.requestId, status: 'accepted' }, include: { request: { select: { id: true, number: true, ownerId: true, status: true } } } });
    if (!row || row.request.status !== 'awaiting_payment' || !row.paymentDueAt || row.paymentDueAt <= new Date()) return;
    await this.prisma.$transaction((tx) => this.notifications.dispatch(tx, 'payment.reminder', { requestCode: format(row.request.number), dueDate: row.paymentDueAt!.toLocaleDateString('en-NG', { timeZone: 'Africa/Lagos' }) }, { requestId: row.request.id, ownerId: row.request.ownerId, actorId: null }));
    await this.outbox.kick();
  }

  private async lapse(timer: RequestTimer) {
    const pending = await this.prisma.payment.findFirst({ where: { requestId: timer.requestId, quoteId: timer.refId, status: 'pending', method: 'paystack' }, select: { id: true } });
    if (pending && await this.payments.recheckPending(pending.id)) return;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`);
      const quote = await tx.quote.findFirst({ where: { id: timer.refId, requestId: timer.requestId, status: 'accepted' }, include: { request: { select: { id: true, number: true, ownerId: true, status: true } } } });
      const now = new Date();
      if (!quote || quote.request.status !== 'awaiting_payment' || !quote.paymentDueAt || quote.paymentDueAt > now) return null;
      const pending = await tx.payment.findFirst({ where: { requestId: quote.requestId, quoteId: quote.id, status: 'pending' }, select: { id: true } });
      const timerPayload = timer.payload && typeof timer.payload === 'object' ? timer.payload as Record<string, unknown> : {};
      if (pending && timerPayload.retried !== true) {
        await this.timers.start(tx, { requestId: quote.requestId, kind: 'T9.lapse', dueAt: new Date(now.getTime() + 30 * 60 * 1000), refId: quote.id, payload: { retried: true } });
        return null;
      }
      await tx.quote.update({ where: { id: quote.id }, data: { status: 'expired' } });
      await tx.serviceRequest.update({ where: { id: quote.requestId }, data: { status: 'matched', version: { increment: 1 }, updatedAt: now } });
      await tx.auditLog.create({ data: { actorType: 'system', entityType: 'service_request', entityId: quote.requestId, action: 'Payment window lapsed', metadata: { quoteId: quote.id } } });
      await this.notifications.dispatch(tx, 'payment.lapsed', { requestCode: format(quote.request.number) }, { requestId: quote.request.id, ownerId: quote.request.ownerId, actorId: null });
      return quote.request.id;
    });
    if (result) await this.outbox.kick();
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
