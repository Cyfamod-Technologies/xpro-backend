import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestTimer } from '@prisma/client';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { TimersService } from '../../platform/timers/timers.service';
import { TimerRegistry } from '../../platform/timers/timer-registry';
import { PrismaService } from '../../prisma/prisma.service';
import {
  evaluateEligibility,
  type DispatchRequest,
} from '../domain/eligibility';
import { rankProviders } from '../domain/ranking';
import { SETTINGS_REGISTRY } from '../../platform/settings/settings.registry';
import type { DispatchWeights } from '../domain/ranking';
import { ProviderDispatchLoader } from './provider-dispatch.loader';

@Injectable()
export class DispatchTimerHandlers {
  constructor(
    registry: TimerRegistry,
    private readonly prisma: PrismaService,
    private readonly providers: ProviderDispatchLoader,
    private readonly notifications: NotificationDispatcher,
    private readonly timers: TimersService,
    private readonly outbox: OutboxService,
  ) {
    registry.register('T1.reminder', (timer) => this.remind(timer));
    registry.register('T1.expire', (timer) => this.expire(timer));
    registry.register('T3.review', (timer) => this.reviewDeadline(timer));
    registry.register('dispatch.cascade', (timer) => this.cascade(timer));
  }

  private async remind(timer: RequestTimer) {
    const assignment = await this.prisma.assignment.findFirst({
      where: { id: timer.refId, requestId: timer.requestId, status: 'offered' },
      include: { request: { select: { number: true, ownerId: true } } },
    });
    if (!assignment || assignment.expiresAt <= new Date()) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        'assignment.reminder',
        {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: format(assignment.request.number),
          service: '',
          district: '',
        },
        {
          requestId: assignment.requestId,
          ownerId: assignment.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async expire(timer: RequestTimer) {
    const data = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`,
      );
      const assignment = await tx.assignment.findFirst({
        where: { id: timer.refId, requestId: timer.requestId },
        include: {
          request: {
            select: {
              id: true,
              number: true,
              ownerId: true,
              dispatchMode: true,
              autoAttempts: true,
            },
          },
        },
      });
      if (
        !assignment ||
        assignment.status !== 'offered' ||
        assignment.expiresAt > new Date()
      )
        return null;
      const now = new Date();
      const result = await tx.assignment.updateMany({
        where: {
          id: assignment.id,
          status: 'offered',
          expiresAt: { lte: now },
        },
        data: {
          status: 'expired',
          endReason: 'expired',
          endedAt: now,
          endedBy: null,
        },
      });
      if (!result.count) return null;
      await tx.providerReliabilityEvent.createMany({
        data: [
          {
            providerId: assignment.providerId,
            kind: 'expired',
            sourceId: assignment.id,
            requestId: assignment.requestId,
            occurredAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const max = Number(
        (
          await tx.setting.findUnique({
            where: { key: 'assignment.maxAutoAttempts' },
            select: { value: true },
          })
        )?.value ??
          SETTINGS_REGISTRY['assignment.maxAutoAttempts'].defaultValue,
      );
      const auto =
        assignment.request.dispatchMode === 'auto' &&
        assignment.request.autoAttempts < max;
      await tx.serviceRequest.update({
        where: { id: assignment.requestId },
        data: {
          status: 'under_review',
          needsAssignmentReason: auto
            ? null
            : assignment.request.autoAttempts >= max
              ? 'limit_reached'
              : 'expired',
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          entityType: 'service_request',
          entityId: assignment.requestId,
          action: 'Offer expired',
          metadata: {
            assignmentId: assignment.id,
            requestId: assignment.requestId,
          },
        },
      });
      await this.notifications.dispatch(
        tx,
        'assignment.expired',
        {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: format(assignment.request.number),
          service: '',
          district: '',
        },
        {
          requestId: assignment.requestId,
          ownerId: assignment.request.ownerId,
          actorId: null,
        },
      );
      if (auto)
        await this.timers.start(tx, {
          requestId: assignment.requestId,
          kind: 'dispatch.cascade',
          dueAt: now,
          payload: { trigger: 'cascade' },
        });
      else
        await this.notifications.dispatch(
          tx,
          'request.needs_manual_assignment',
          { requestCode: format(assignment.request.number) },
          {
            requestId: assignment.requestId,
            ownerId: assignment.request.ownerId,
            actorId: null,
          },
        );
      return { requestId: assignment.requestId, auto };
    });
    if (data?.auto) await this.timers.kick();
    if (data) await this.outbox.kick();
  }

  private async reviewDeadline(timer: RequestTimer) {
    const assignment = await this.prisma.assignment.findFirst({
      where: {
        id: timer.refId,
        requestId: timer.requestId,
        status: 'pending_approval',
      },
      include: {
        request: { select: { id: true, number: true, ownerId: true } },
      },
    });
    if (!assignment) return;
    await this.prisma.$transaction((tx) =>
      this.notifications.dispatch(
        tx,
        'assignment.accepted',
        { requestCode: format(assignment.request.number) },
        {
          requestId: assignment.requestId,
          ownerId: assignment.request.ownerId,
          actorId: null,
        },
      ),
    );
    await this.outbox.kick();
  }

  private async cascade(timer: RequestTimer) {
    const runResult = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM service_requests WHERE id = ${timer.requestId}::uuid FOR UPDATE`,
      );
      if (!locked.length) return null;
      const request = await tx.serviceRequest.findUnique({
        where: { id: timer.requestId },
      });
      if (
        !request ||
        request.status !== 'under_review' ||
        request.intakeState !== 'approved'
      )
        return null;
      const current = await tx.assignment.findFirst({
        where: {
          requestId: request.id,
          status: { in: ['offered', 'pending_approval', 'accepted'] },
        },
      });
      if (current) return null;
      const settings = Object.fromEntries(
        (await tx.setting.findMany()).map(({ key, value }) => [key, value]),
      );
      const max = Number(
        settings['assignment.maxAutoAttempts'] ??
          SETTINGS_REGISTRY['assignment.maxAutoAttempts'].defaultValue,
      );
      if (request.dispatchMode !== 'auto' || request.autoAttempts >= max) {
        const reason =
          request.autoAttempts >= max ? 'limit_reached' : 'manual_mode';
        await tx.serviceRequest.update({
          where: { id: request.id },
          data: { needsAssignmentReason: reason },
        });
        await this.notifications.dispatch(
          tx,
          'request.needs_manual_assignment',
          { requestCode: format(request.number) },
          { requestId: request.id, ownerId: request.ownerId, actorId: null },
        );
        return { notify: true, requestId: request.id };
      }
      const providers = await this.providers.list(new Date(), request.id);
      const district = await tx.location.findUnique({
        where: { id: request.districtId },
        select: { name: true },
      });
      const details =
        request.details && typeof request.details === 'object'
          ? (request.details as Record<string, unknown>)
          : {};
      const skill = typeof details.skill === 'string' ? details.skill : null;
      const dispatchRequest: DispatchRequest = {
        id: request.id,
        ownerId: request.ownerId,
        service: request.service,
        skill,
        cityId: request.cityId,
        districtId: request.districtId,
        districtName: district?.name ?? '',
        effectiveStartDate: request.startDate,
        effectiveEndDate:
          typeof details.endDate === 'string' ? details.endDate : null,
      };
      const excluded = [] as Array<Record<string, unknown>>;
      const eligible = providers.filter((provider) => {
        const result = evaluateEligibility(provider, dispatchRequest, {
          requireVerifiedBank:
            settings['assignment.requireVerifiedBank'] !== false,
        });
        if (!result.eligible)
          excluded.push({
            providerId: provider.id,
            providerName: provider.name,
            rule: result.rule,
            reason: result.reason,
          });
        return result.eligible;
      });
      const ranked = rankProviders(
        eligible,
        dispatchRequest,
        (settings['assignment.weights'] ??
          SETTINGS_REGISTRY['assignment.weights']
            .defaultValue) as DispatchWeights,
        new Date(),
      );
      const now = new Date();
      const run = await tx.dispatchRun.create({
        data: {
          requestId: request.id,
          trigger: 'cascade',
          actorId: null,
          at: now,
          settings: settings,
          eligible: ranked.map(({ provider, total, factors }) => ({
            providerId: provider.id,
            providerName: provider.name,
            total,
            factors,
          })),
          excluded: excluded as Prisma.InputJsonArray,
        },
      });
      if (!ranked.length) {
        await tx.serviceRequest.update({
          where: { id: request.id },
          data: { needsAssignmentReason: 'no_eligible', lastRunId: run.id },
        });
        await this.notifications.dispatch(
          tx,
          'request.needs_manual_assignment',
          { requestCode: format(request.number) },
          { requestId: request.id, ownerId: request.ownerId, actorId: null },
        );
        return { notify: true, requestId: request.id };
      }
      const choice = ranked[0];
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${choice.provider.id} FOR UPDATE`,
      );
      const expiry = new Date(
        now.getTime() +
          Number(settings['assignment.offerExpiryHours'] ?? 24) *
            60 *
            60 *
            1000,
      );
      const assignment = await tx.assignment.create({
        data: {
          requestId: request.id,
          providerId: choice.provider.id,
          providerUserId: choice.provider.userId,
          status: 'offered',
          source: 'auto',
          attempt: request.autoAttempts + 1,
          rankingRunId: run.id,
          score: { total: choice.total, factors: choice.factors },
          offeredAt: now,
          expiresAt: expiry,
        },
      });
      await tx.providerProfile.update({
        where: { id: choice.provider.id },
        data: { lastOfferedAt: now },
      });
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: {
          autoAttempts: { increment: 1 },
          needsAssignmentReason: null,
          lastRunId: run.id,
        },
      });
      await this.timers.start(tx, {
        requestId: request.id,
        kind: 'T1.reminder',
        dueAt: new Date(
          now.getTime() + (expiry.getTime() - now.getTime()) * 0.75,
        ),
        refId: assignment.id,
      });
      await this.timers.start(tx, {
        requestId: request.id,
        kind: 'T1.expire',
        dueAt: expiry,
        refId: assignment.id,
      });
      await this.notifications.dispatch(
        tx,
        'assignment.offered',
        {
          assignmentId: assignment.id,
          providerUserId: choice.provider.userId,
          requestCode: format(request.number),
          service: request.service,
          district: district?.name ?? '',
          skill: skill ?? request.service,
        },
        { requestId: request.id, ownerId: request.ownerId, actorId: null },
      );
      return { notify: true, requestId: request.id };
    });
    if (runResult?.notify) {
      await this.timers.kick();
      await this.outbox.kick();
    }
  }
}

const format = (number: number) => `XPR-${String(number).padStart(5, '0')}`;
