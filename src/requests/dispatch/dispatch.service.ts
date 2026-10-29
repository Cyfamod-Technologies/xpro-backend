import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requirePermission,
  requireProvider,
} from '../../platform/actor/actor.guards';
import type { ActorContext } from '../../platform/actor/actor.types';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { SETTINGS_REGISTRY } from '../../platform/settings/settings.registry';
import { addWorkingMinutes } from '../../platform/calendar/business-calendar';
import type { TimerKind } from '../../platform/timers/timer-kinds';
import { PrismaService } from '../../prisma/prisma.service';
import { rejectPendingUpdates } from '../cancellation/cancellation-cleanup';
import {
  closeOpenApprovals,
  PROVIDER_BOUND_APPROVAL_KINDS,
} from '../approval-effects';
import { RequestCommandRunner, type CommandContext } from '../command-runner';
import {
  assessManualOffer,
  assessReviewRecheck,
  noLongerAvailableMessage,
  OFFER_NOT_APPROVED_MESSAGE,
  OFFER_STALE_MESSAGE,
} from '../domain/assignment-rules';
import { dispatchRequestFor } from '../domain/dispatch-request';
import { offerExpiry } from '../domain/offer-expiry';
import {
  evaluateAll,
  evaluateEligibility,
  type DispatchProvider,
} from '../domain/eligibility';
import { providerBlocked } from '../domain/provider-standing';
import { rankProviders, type DispatchWeights } from '../domain/ranking';
import { runAutoDispatch } from './dispatch-engine';
import { ProviderDispatchLoader } from './provider-dispatch.loader';

const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const requestNotFound = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This request is no longer available to your account.',
  );
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const settingHours = (
  ctx: CommandContext,
  key: 'pricing.stallReminderHours' | 'pricing.stallEscalateHours',
) => Number(ctx.settings[key] ?? SETTINGS_REGISTRY[key].defaultValue);

const REVIEW_WORKING_MINUTES = 4 * 60;
const SCHEDULE_TIMERS: TimerKind[] = [
  'T11.reminder24h',
  'T11.staff48h',
  'T12.reminder24h',
  'T12.reminder2h',
  'T13.noShowCheck',
];
const QUOTE_TIMERS: TimerKind[] = [
  'T8.reminder3d',
  'T8.reminder1d',
  'T8.expire',
];

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly providers: ProviderDispatchLoader,
  ) {}

  async rankingRun(userId: string, ref: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'dispatch.manage');
    // One instant for the providers, the ranking and the stored run (04 §6.6 determinism).
    const at = new Date();
    const row = await this.findRequest(ref);
    const settings = Object.fromEntries(
      (await this.prisma.setting.findMany()).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    const locations = await this.prisma.location.findMany({
      where: { id: { in: [row.districtId, row.cityId] } },
      select: { id: true, name: true },
    });
    const request = await dispatchRequestFor(this.prisma, row, {
      districtName: locations.find(({ id }) => id === row.districtId)?.name,
      cityName: locations.find(({ id }) => id === row.cityId)?.name,
    });
    const providers = await this.providers.list(at, row.id);
    const weights = (settings['assignment.weights'] ??
      SETTINGS_REGISTRY['assignment.weights'].defaultValue) as DispatchWeights;
    const excluded = [] as Array<{
      providerId: string;
      providerName: string;
      rule: string;
      reason: string;
    }>;
    const eligibleProviders: DispatchProvider[] = [];
    for (const provider of providers) {
      const result = evaluateEligibility(provider, request, {
        requireVerifiedBank:
          settings['assignment.requireVerifiedBank'] !== false,
      });
      if (result.eligible) eligibleProviders.push(provider);
      else
        excluded.push({
          providerId: provider.id,
          providerName: provider.name,
          rule: result.rule,
          reason: result.reason,
        });
    }
    const eligible = rankProviders(eligibleProviders, request, weights, at).map(
      (item) => ({
        providerId: item.provider.id,
        providerName: item.provider.name,
        total: item.total,
        factors: item.factors,
      }),
    );
    const run = await this.prisma.dispatchRun.create({
      data: {
        requestId: row.id,
        trigger: 'staff_view',
        actorId: userId,
        at,
        settings: settings,
        eligible: eligible,
        excluded: excluded,
      },
    });
    return { runId: run.id, at, eligible, excluded };
  }

  async autoAssign(
    userId: string,
    ref: string,
    dto: { resetAttempts?: boolean; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'assignment.auto',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        // The runner guard (04 §6.6) already refused a run at the limit without `resetAttempts`.
        await runAutoDispatch(this.providers, ctx, {
          trigger: 'staff_auto',
          actorId: userId,
          request,
          attemptsBefore: dto.resetAttempts ? 0 : request.autoAttempts,
          note: dto.note,
        });
      },
    );
  }

  async review(
    userId: string,
    ref: string,
    assignmentId: string,
    dto: {
      approve: boolean;
      note?: string;
      share?: { description: boolean; attachmentIds: string[] };
      overrideNote?: string;
    },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'assignment.review',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        // The runner guard checked the current assignment; the path id needs the row (04 §6.9 row 1).
        const assignment = await ctx.tx.assignment.findFirst({
          where: { id: assignmentId, requestId: ctx.snap.id },
        });
        if (!assignment || assignment.status !== 'pending_approval')
          throw conflict('This assignment is no longer awaiting approval.');
        if (!dto.approve) {
          const note = dto.note?.trim() ?? '';
          await ctx.tx.assignment.update({
            where: { id: assignment.id },
            data: {
              status: 'not_confirmed',
              endReason: 'acceptance_rejected',
              endedAt: ctx.now,
              endedBy: userId,
              reviewedBy: userId,
              reviewedAt: ctx.now,
              reviewNote: note,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: {
              needsAssignmentReason: 'acceptance_rejected',
              status: 'under_review',
            },
          });
          ctx.timers.stop('T3.review', assignment.id);
          ctx.approvals.close('assignment', assignment.id, 'rejected');
          ctx.audit('Assignment rejected', {
            resourceType: 'assignment',
            resourceId: assignment.id,
            note,
          });
          ctx.notify('assignment.not_confirmed', {
            assignmentId: assignment.id,
            providerUserId: assignment.providerUserId,
            requestCode: ctx.snap.number,
            note,
          });
          if (
            ctx.snap.currentAssignment?.status === 'pending_approval' &&
            ctx.snap.status === 'under_review'
          )
            ctx.enqueueCascade('cascade');
          else {
            ctx.approvals.open('needs_assignment', ctx.snap.id);
            ctx.notify('request.needs_manual_assignment', {
              requestCode: ctx.snap.number,
            });
          }
          return;
        }
        const requestRow = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        const provider = await this.providers.one(
          assignment.providerId,
          ctx.now,
          ctx.snap.id,
          ctx.tx,
        );
        if (!provider || !requestRow)
          throw conflict(
            'The provider is no longer available. Refresh the request.',
          );
        // 04 §6.9 re-check table; capacity and previous aren't re-checked for the provider's own offer.
        const recheck = assessReviewRecheck({
          providerName: provider.name,
          failures: evaluateAll(
            provider,
            await dispatchRequestFor(ctx.tx, requestRow, {
              districtName: ctx.snap.districtName,
              cityName: ctx.snap.cityName,
            }),
            {
              requireVerifiedBank:
                ctx.settings['assignment.requireVerifiedBank'] !== false,
            },
          ),
          overrideNote: dto.overrideNote,
        });
        if (!recheck.ok)
          throw new AppError(recheck.status, recheck.code, recheck.message);
        const sharedDetails = await this.releasedOnConfirm(
          ctx,
          requestRow.shareOnConfirm,
          dto.share,
          userId,
        );
        const updated = await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'accepted',
            reviewedBy: userId,
            reviewedAt: ctx.now,
            reviewNote: dto.note?.trim() || null,
            sharedDetails,
          },
        });
        const acceptedQuote = await ctx.tx.quote.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { version: 'desc' },
        });
        const payment = acceptedQuote
          ? await ctx.tx.payment.findFirst({
              where: {
                requestId: ctx.snap.id,
                quoteId: acceptedQuote.id,
                status: { in: ['paid', 'partially_refunded'] },
              },
            })
          : null;
        const nextStatus = payment
          ? 'ready_to_schedule'
          : acceptedQuote
            ? 'awaiting_payment'
            : 'matched';
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: nextStatus, needsAssignmentReason: null },
        });
        ctx.timers.stop('T3.review', assignment.id);
        ctx.approvals.close('assignment', assignment.id, 'approved');
        ctx.approvals.close('needs_assignment', ctx.snap.id, 'assigned');
        // 02 §6.11: a paid request waits for a schedule as soon as the new provider is confirmed.
        if (nextStatus === 'ready_to_schedule')
          ctx.approvals.open('schedule_needed', ctx.snap.id);
        if (!acceptedQuote) {
          const hour = 60 * 60 * 1000;
          ctx.timers.start(
            'T7.reminder24h',
            new Date(
              ctx.now.getTime() +
                settingHours(ctx, 'pricing.stallReminderHours') * hour,
            ),
            assignment.id,
          );
          ctx.timers.start(
            'T7.stall48h',
            new Date(
              ctx.now.getTime() +
                settingHours(ctx, 'pricing.stallEscalateHours') * hour,
            ),
            assignment.id,
          );
        }
        // FD-7: no payout is created here. The primary payout is created once, at completion confirmation.
        ctx.audit('Assignment approved', {
          resourceType: 'assignment',
          resourceId: updated.id,
          note: dto.note,
          changes: recheck.overridden
            ? {
                overrideNote: dto.overrideNote?.trim(),
                overriddenRules: recheck.overriddenRules,
              }
            : undefined,
        });
        ctx.notify('assignment.confirmed_customer', {
          requestCode: ctx.snap.number,
        });
        ctx.notify('assignment.confirmed_provider', {
          assignmentId: updated.id,
          requestCode: ctx.snap.number,
          providerUserId: updated.providerUserId,
        });
      },
    );
  }

  async withdraw(
    userId: string,
    ref: string,
    assignmentId: string,
    note: string,
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'assignment.withdraw',
      ref,
      version,
      url,
      { assignmentId, note },
      key,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: assignmentId,
            requestId: ctx.snap.id,
            status: { in: ['offered', 'pending_approval', 'accepted'] },
          },
        });
        if (!assignment) throw conflict('This offer is no longer current.');
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'withdrawn',
            endReason: 'withdrawn',
            endedAt: ctx.now,
            endedBy: userId,
            response: note.trim(),
          },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'under_review', needsAssignmentReason: 'withdrawn' },
        });
        ctx.timers.stop(
          [
            'T1.reminder',
            'T1.expire',
            'T3.review',
            'T7.reminder24h',
            'T7.stall48h',
          ],
          assignment.id,
        );
        // 04 §5.5, §5.6: unpaid sent quotes are superseded and open schedules cancelled.
        const sentQuotes = await ctx.tx.quote.findMany({
          where: { requestId: ctx.snap.id, status: 'sent' },
          select: { id: true },
        });
        if (sentQuotes.length) {
          await ctx.tx.quote.updateMany({
            where: { id: { in: sentQuotes.map(({ id }) => id) } },
            data: { status: 'superseded' },
          });
          for (const quote of sentQuotes)
            ctx.timers.stop(QUOTE_TIMERS, quote.id);
        }
        await this.cancelOpenSchedules(ctx);
        await rejectPendingUpdates(ctx, assignment.id);
        ctx.approvals.close('assignment', assignment.id, 'withdrawn');
        ctx.approvals.open('needs_assignment', ctx.snap.id);
        await closeOpenApprovals(
          ctx,
          PROVIDER_BOUND_APPROVAL_KINDS,
          'withdrawn',
        );
        const dispatchRequest = await dispatchRequestFor(ctx.tx, request, {
          districtName: ctx.snap.districtName,
          cityName: ctx.snap.cityName,
        });
        ctx.audit('Assignment withdrawn', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note,
          changes: {
            wasAccepted: assignment.status === 'accepted',
            supersededQuoteIds: sentQuotes.map(({ id }) => id),
          },
        });
        ctx.notify('request.offer_withdrawn', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
          service: request.service,
          district: ctx.snap.districtName ?? '',
          skill: dispatchRequest.skill ?? request.service,
        });
      },
    );
  }

  async replace(
    userId: string,
    ref: string,
    assignmentId: string,
    dto: { note: string; workStarted?: boolean },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'assignment.replace',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        // The runner guard checked the status rules of 04 §5.2 #21 (including the `blocked` rule); the path id needs the row.
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: assignmentId,
            requestId: ctx.snap.id,
            status: 'accepted',
          },
        });
        if (!assignment)
          throw conflict('This provider is no longer assigned to the request.');
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        const note = dto.note.trim();
        const workStarted = dto.workStarted ?? assignment.workStarted;
        await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'replaced',
            endReason: 'replaced',
            endedAt: ctx.now,
            endedBy: userId,
            workStarted,
          },
        });
        await ctx.tx.quote.updateMany({
          where: {
            requestId: ctx.snap.id,
            status: { in: ['accepted', 'sent'] },
          },
          data: { providerChangedAt: ctx.now },
        });
        await this.cancelOpenSchedules(ctx);
        await rejectPendingUpdates(ctx, assignment.id);
        ctx.approvals.open('needs_assignment', ctx.snap.id);
        await closeOpenApprovals(
          ctx,
          PROVIDER_BOUND_APPROVAL_KINDS,
          'replaced',
        );
        // FD-7: the old provider's primary payout never pays out; the new provider's is created at completion.
        const payouts = await ctx.tx.payout.findMany({
          where: {
            assignmentId: assignment.id,
            kind: 'primary',
            status: { notIn: ['paid', 'processing', 'cancelled', 'reversed'] },
          },
          select: { id: true },
        });
        if (payouts.length)
          await ctx.tx.payout.updateMany({
            where: { id: { in: payouts.map(({ id }) => id) } },
            data: {
              status: 'cancelled',
              holdReason: 'Provider replaced on this request.',
              holdSource: 'replacement',
              version: { increment: 1 },
            },
          });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'under_review', needsAssignmentReason: 'replaced' },
        });
        ctx.timers.stop(['T7.reminder24h', 'T7.stall48h'], assignment.id);
        const dispatchRequest = await dispatchRequestFor(ctx.tx, request, {
          districtName: ctx.snap.districtName,
          cityName: ctx.snap.cityName,
        });
        ctx.audit('Assignment replaced', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note,
          changes: {
            oldAssignmentId: assignment.id,
            workStarted,
            cancelledPayoutIds: payouts.map(({ id }) => id),
          },
        });
        ctx.notify('assignment.replaced_customer', {
          requestCode: ctx.snap.number,
        });
        ctx.notify('assignment.replaced_provider', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
          service: request.service,
          district: ctx.snap.districtName ?? '',
          skill: dispatchRequest.skill ?? request.service,
        });
      },
    );
  }

  async shareDetails(
    userId: string,
    ref: string,
    dto: { attachmentIds?: string[]; fields?: string[]; note?: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'request.shareDetails',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        if (!assignment)
          throw conflict(
            'Confirm a provider assignment before sharing job details.',
          );
        const fields = [...new Set(dto.fields ?? [])];
        const attachmentIds = [...new Set(dto.attachmentIds ?? [])];
        await this.requireOwnAttachments(ctx, attachmentIds);
        const existing = object(assignment.sharedDetails);
        const nextFields = [
          ...new Set([...stringList(existing.fields), ...fields]),
        ];
        const nextAttachments = [
          ...new Set([...stringList(existing.attachmentIds), ...attachmentIds]),
        ];
        // Merge: the description flag the confirmation released stays (04 §4.5 `sharedDetails`).
        await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            sharedDetails: {
              ...existing,
              description: existing.description === true,
              attachmentIds: nextAttachments,
              fields: nextFields,
              at: ctx.now.toISOString(),
              by: userId,
            },
          },
        });
        ctx.notify('request.details_shared', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
        });
        ctx.audit('Details shared with provider', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note: dto.note,
          changes: { fields, attachmentIds },
        });
      },
    );
  }

  async setMode(
    userId: string,
    ref: string,
    dto: { mode: 'auto' | 'manual'; note: string },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'dispatch.setMode',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const note = dto.note.trim();
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { dispatchMode: dto.mode },
        });
        ctx.audit('Assignment mode changed', {
          note,
          changes: { mode: dto.mode },
        });
      },
    );
  }

  async offer(
    userId: string,
    ref: string,
    dto: {
      providerId: string;
      rankingRunId: string;
      note?: string;
      overrideNote?: string;
    },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.staff(userId, 'dispatch.manage');
    return this.run(
      actor,
      'assignment.offer',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        // 04 §6.6 manual offer table; the staleness check needs the stored run.
        const run = await ctx.tx.dispatchRun.findFirst({
          where: {
            id: dto.rankingRunId,
            requestId: ctx.snap.id,
            trigger: 'staff_view',
          },
        });
        const maxAge = Number(
          ctx.settings['assignment.rankingRunMaxAgeMinutes'] ?? 15,
        );
        if (!run || ctx.now.getTime() - run.at.getTime() > maxAge * 60_000)
          throw conflict(OFFER_STALE_MESSAGE);
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        // Capacity locking (REQ-13a): lock the provider, then recount and re-run the rules from fresh data.
        const locked = await ctx.tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${dto.providerId} FOR UPDATE`,
        );
        const provider = locked.length
          ? await this.providers.one(
              dto.providerId,
              ctx.now,
              ctx.snap.id,
              ctx.tx,
            )
          : null;
        if (!provider)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            OFFER_NOT_APPROVED_MESSAGE,
          );
        const failures = evaluateAll(
          provider,
          await dispatchRequestFor(ctx.tx, request, {
            districtName: ctx.snap.districtName,
            cityName: ctx.snap.cityName,
          }),
          {
            requireVerifiedBank:
              ctx.settings['assignment.requireVerifiedBank'] !== false,
          },
        );
        const ranked = run.eligible as Array<{
          providerId: string;
          total: number;
          factors: Record<string, number>;
        }>;
        const matched = ranked.find((item) => item.providerId === provider.id);
        if (matched && failures.length)
          throw conflict(
            noLongerAvailableMessage(provider.name, failures[0].reason),
          );
        const topSuggestionId = ranked[0]?.providerId ?? null;
        const assessment = assessManualOffer({
          failures,
          providerId: provider.id,
          topSuggestionId,
          overrideNote: dto.overrideNote,
        });
        if (!assessment.ok)
          throw new AppError(
            assessment.status,
            assessment.code,
            assessment.message,
          );
        const expiry = offerExpiry(
          ctx.now,
          Number(ctx.settings['assignment.offerExpiryHours'] ?? 24),
          Number(ctx.settings['assignment.offerMinWorkingHours'] ?? 4),
          provider.workingHours,
          provider.timeOff,
        );
        const assignment = await ctx.tx.assignment.create({
          data: {
            requestId: ctx.snap.id,
            providerId: provider.id,
            providerUserId: provider.userId,
            status: 'offered',
            source: 'manual',
            attempt: null,
            rankingRunId: run.id,
            score: matched
              ? { total: matched.total, factors: matched.factors }
              : Prisma.JsonNull,
            overrideNote: dto.overrideNote?.trim() || null,
            overriddenRules: assessment.overriddenRules,
            note: dto.note?.trim() || null,
            offeredAt: ctx.now,
            expiresAt: expiry,
          },
        });
        await ctx.tx.providerProfile.update({
          where: { id: provider.id },
          data: { lastOfferedAt: ctx.now },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: request.id },
          data: { status: 'under_review', needsAssignmentReason: null },
        });
        ctx.timers.start(
          'T1.reminder',
          new Date(
            ctx.now.getTime() + (expiry.getTime() - ctx.now.getTime()) * 0.75,
          ),
          assignment.id,
        );
        ctx.timers.start('T1.expire', expiry, assignment.id);
        ctx.approvals.close('needs_assignment', ctx.snap.id, 'offered');
        ctx.audit('Assignment offered', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note: dto.note,
          changes: { providerId: provider.id, source: 'manual' },
        });
        if (assessment.noteRequired)
          ctx.audit('Dispatch suggestion overridden', {
            resourceType: 'assignment',
            resourceId: assignment.id,
            note: dto.overrideNote,
            changes: {
              rules: assessment.overriddenRules,
              topSuggestionId,
              providerId: provider.id,
            },
          });
        ctx.notify('assignment.offered', {
          assignmentId: assignment.id,
          providerUserId: provider.userId,
          requestCode: ctx.snap.number,
          service: request.service,
          district: ctx.snap.districtName ?? '',
          skill:
            (
              await dispatchRequestFor(ctx.tx, request, {
                districtName: ctx.snap.districtName,
                cityName: ctx.snap.cityName,
              })
            ).skill ?? request.service,
        });
      },
    );
  }

  async respond(
    userId: string,
    ref: string,
    assignmentId: string,
    dto: { accept: boolean; note?: string; crewSize?: number },
    version: number | undefined,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requireProvider(actor);
    return this.run(
      actor,
      'assignment.respond',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: assignmentId,
            requestId: ctx.snap.id,
            providerUserId: userId,
          },
        });
        // The runner guard checked the current offer, expiry and the decline reason; the path id needs the row (04 §6.8 row 1).
        if (!assignment || assignment.status !== 'offered')
          throw conflict('This offer is no longer awaiting your response.');
        if (!dto.accept) {
          const note = dto.note?.trim() ?? '';
          await ctx.tx.assignment.update({
            where: { id: assignment.id },
            data: {
              status: 'declined',
              endReason: 'declined',
              endedAt: ctx.now,
              endedBy: userId,
              response: note,
              respondedAt: ctx.now,
            },
          });
          await ctx.tx.providerReliabilityEvent.createMany({
            data: [
              {
                providerId: assignment.providerId,
                kind: 'declined',
                sourceId: assignment.id,
                requestId: assignment.requestId,
                occurredAt: ctx.now,
                note,
              },
            ],
            skipDuplicates: true,
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { needsAssignmentReason: 'declined', status: 'under_review' },
          });
          ctx.audit('Provider declined assignment', {
            resourceType: 'assignment',
            resourceId: assignment.id,
            note,
          });
          ctx.timers.stop(['T1.reminder', 'T1.expire'], assignment.id);
          ctx.enqueueCascade('cascade');
          return;
        }
        const profile = await ctx.tx.providerProfile.findUnique({
          where: { id: assignment.providerId },
          include: { user: { select: { status: true } } },
        });
        // 04 §6.8 row 3; E2 also refuses a restricted provider (FD-6).
        if (
          !profile ||
          profile.verification !== 'approved' ||
          !profile.available ||
          providerBlocked({
            userStatus: profile.user.status,
            verification: profile.verification,
            reliabilityStatus: profile.reliabilityStatus,
          }).blocked
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Your profile must be approved and available to accept work.',
          );
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        const hireQuantity =
          request.service === 'Hire'
            ? Number(object(request.details).quantity ?? 1)
            : 1;
        if (hireQuantity > 1 && dto.crewSize !== hireQuantity)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `Confirm you can supply a crew of ${hireQuantity}.`,
          );
        const changed = await ctx.tx.assignment.updateMany({
          where: {
            id: assignment.id,
            status: 'offered',
            expiresAt: { gt: ctx.now },
          },
          data: {
            status: 'pending_approval',
            response: dto.note?.trim(),
            crewConfirmed: hireQuantity > 1 ? dto.crewSize : null,
            respondedAt: ctx.now,
          },
        });
        if (changed.count !== 1)
          throw conflict('This offer is no longer awaiting your response.');
        ctx.timers.stop(['T1.reminder', 'T1.expire'], assignment.id);
        // T3 is 4 working hours (Q16).
        ctx.timers.start(
          'T3.review',
          addWorkingMinutes(
            ctx.now,
            REVIEW_WORKING_MINUTES,
            (ctx.settings['calendar.holidays'] as string[] | undefined) ?? [],
          ),
          assignment.id,
        );
        // 02 §6.11: the provider-acceptance item runs from the provider's reply.
        ctx.approvals.open('assignment', assignment.id);
        ctx.audit('Provider accepted assignment', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note: dto.note,
        });
        ctx.notify('assignment.accepted', { requestCode: ctx.snap.number });
      },
    );
  }

  private async staff(userId: string, permission: 'dispatch.manage') {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, permission);
    return actor;
  }
  private async findRequest(ref: string) {
    const number = /^XPR-(\d+)$/i.exec(ref)?.[1];
    const row = number
      ? await this.prisma.serviceRequest.findUnique({
          where: { number: Number(number) },
        })
      : await this.prisma.serviceRequest.findUnique({ where: { id: ref } });
    if (!row) throw requestNotFound();
    return row;
  }
  /** `sharedDetails` released when staff approve: the explicit `share`, else the request's `shareOnConfirm` (04 §6.9). */
  private async releasedOnConfirm(
    ctx: CommandContext,
    shareOnConfirm: unknown,
    share: { description: boolean; attachmentIds: string[] } | undefined,
    userId: string,
  ): Promise<Prisma.InputJsonValue> {
    const defaults = object(shareOnConfirm);
    const attachmentIds = [
      ...new Set(share?.attachmentIds ?? stringList(defaults.attachmentIds)),
    ];
    await this.requireOwnAttachments(ctx, attachmentIds);
    return {
      description: share ? share.description : defaults.description !== false,
      attachmentIds,
      fields: [],
      at: ctx.now.toISOString(),
      by: userId,
    };
  }

  private async requireOwnAttachments(
    ctx: CommandContext,
    attachmentIds: readonly string[],
  ): Promise<void> {
    if (!attachmentIds.length) return;
    const owned = await ctx.tx.requestAttachment.count({
      where: { requestId: ctx.snap.id, uploadId: { in: [...attachmentIds] } },
    });
    // Same message as intake approval (04 §6.4): only files attached to this request can be released.
    if (owned !== attachmentIds.length)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose only files attached to this request to share with the provider.',
      );
  }

  /** Withdraw and replace cancel every unconfirmed or confirmed schedule and stop its timers (04 §5.6). */
  private async cancelOpenSchedules(ctx: CommandContext): Promise<string[]> {
    const open = await ctx.tx.schedule.findMany({
      where: {
        requestId: ctx.snap.id,
        status: { in: ['proposed', 'changes_requested', 'confirmed'] },
      },
      select: { id: true },
    });
    if (!open.length) return [];
    await ctx.tx.schedule.updateMany({
      where: { id: { in: open.map(({ id }) => id) } },
      data: { status: 'cancelled' },
    });
    for (const schedule of open) ctx.timers.stop(SCHEDULE_TIMERS, schedule.id);
    return open.map(({ id }) => id);
  }

  private run(
    actor: ActorContext,
    command: string,
    ref: string,
    version: number | undefined,
    url: string,
    body: unknown,
    key: string | undefined,
    fn: (ctx: CommandContext) => Promise<void>,
  ) {
    return this.runner.run(
      {
        command,
        actor,
        requestRef: ref,
        expectedVersion: version,
        input: body,
        ...(key
          ? {
              idempotencyKey: key,
              idempotencyHash: hashRequest('POST', url, body),
            }
          : {}),
      },
      fn,
    );
  }
}
