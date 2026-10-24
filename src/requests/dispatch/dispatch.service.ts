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
import {
  serviceLines,
  intakeFields,
} from '../../platform/catalog/service-lines';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestCommandRunner, type CommandContext } from '../command-runner';
import { offerExpiry } from '../domain/offer-expiry';
import {
  evaluateEligibility,
  OVERRIDABLE_RULES,
  type DispatchProvider,
  type DispatchRequest,
} from '../domain/eligibility';
import { rankProviders, type DispatchWeights } from '../domain/ranking';
import { ProviderDispatchLoader } from './provider-dispatch.loader';

const noAccess = () =>
  new AppError(403, 'FORBIDDEN', 'Your staff role does not allow this action.');
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
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

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
    const row = await this.findRequest(ref);
    const settings = Object.fromEntries(
      (await this.prisma.setting.findMany()).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    const request = this.toDispatchRequest(row);
    const providers = await this.providers.list(new Date(), row.id);
    const weights = (settings['assignment.weights'] ??
      SETTINGS_REGISTRY['assignment.weights'].defaultValue) as DispatchWeights;
    const eligible = [] as Array<{
      providerId: string;
      providerName: string;
      total: number;
      factors: Record<string, number>;
    }>;
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
    const ranked = rankProviders(
      eligibleProviders,
      request,
      weights,
      new Date(),
    );
    for (const item of ranked)
      eligible.push({
        providerId: item.provider.id,
        providerName: item.provider.name,
        total: item.total,
        factors: item.factors,
      });
    const at = new Date();
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
    await this.prisma.serviceRequest.update({
      where: { id: row.id },
      data: { lastRunId: run.id },
    });
    return { runId: run.id, at, eligible, excluded };
  }

  async autoAssign(
    userId: string,
    ref: string,
    dto: { resetAttempts?: boolean; note?: string },
    version: number,
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
        if (!['under_review', 'matched'].includes(ctx.snap.status))
          throw conflict('This request does not need an assignment.');
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        const maxAttempts = Number(
          ctx.settings['assignment.maxAutoAttempts'] ?? 3,
        );
        if (request.autoAttempts >= maxAttempts && !dto.resetAttempts)
          throw conflict(
            `Automatic assignment has used its ${maxAttempts} offers. Reset the count with a note, or choose a provider.`,
          );
        if (dto.resetAttempts && !dto.note?.trim())
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a note explaining why you are resetting automatic assignment.',
          );
        const previousCount = dto.resetAttempts ? 0 : request.autoAttempts;
        const candidates = await this.providers.list(ctx.now, ctx.snap.id);
        const dispatchRequest = this.toDispatchRequest(request);
        const eligible = candidates.filter(
          (candidate) =>
            evaluateEligibility(candidate, dispatchRequest, {
              requireVerifiedBank:
                ctx.settings['assignment.requireVerifiedBank'] !== false,
            }).eligible,
        );
        const ranked = rankProviders(
          eligible,
          dispatchRequest,
          (ctx.settings['assignment.weights'] ??
            SETTINGS_REGISTRY['assignment.weights']
              .defaultValue) as DispatchWeights,
          ctx.now,
        );
        const run = await ctx.tx.dispatchRun.create({
          data: {
            requestId: ctx.snap.id,
            trigger: 'staff_auto',
            actorId: userId,
            at: ctx.now,
            settings: ctx.settings as Prisma.InputJsonValue,
            eligible: ranked.map(({ provider, total, factors }) => ({
              providerId: provider.id,
              providerName: provider.name,
              total,
              factors,
            })),
            excluded: [] as Prisma.InputJsonArray,
          },
        });
        if (!ranked.length || previousCount >= maxAttempts) {
          const reason =
            previousCount >= maxAttempts ? 'limit_reached' : 'no_eligible';
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: {
              needsAssignmentReason: reason,
              lastRunId: run.id,
              autoAttempts: previousCount,
            },
          });
          ctx.audit('Automatic assignment needs staff', {
            note: dto.note,
            changes: { reason, runId: run.id },
          });
          ctx.notify('request.needs_manual_assignment', {
            requestCode: ctx.snap.number,
          });
          return;
        }
        const choice = ranked[0];
        const profile = await ctx.tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${choice.provider.id} FOR UPDATE`,
        );
        if (!profile.length)
          throw conflict(
            'The provider is no longer available. Refresh the ranked list.',
          );
        const expiry = offerExpiry(
          ctx.now,
          Number(ctx.settings['assignment.offerExpiryHours'] ?? 24),
          Number(ctx.settings['assignment.offerMinWorkingHours'] ?? 4),
          choice.provider.workingHours,
          choice.provider.timeOff,
        );
        const assignment = await ctx.tx.assignment.create({
          data: {
            requestId: ctx.snap.id,
            providerId: choice.provider.id,
            providerUserId: choice.provider.userId,
            status: 'offered',
            source: 'auto',
            attempt: previousCount + 1,
            rankingRunId: run.id,
            score: { total: choice.total, factors: choice.factors },
            note: dto.note?.trim() || null,
            offeredAt: ctx.now,
            expiresAt: expiry,
          },
        });
        await ctx.tx.providerProfile.update({
          where: { id: choice.provider.id },
          data: { lastOfferedAt: ctx.now },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: {
            autoAttempts: previousCount + 1,
            needsAssignmentReason: null,
            lastRunId: run.id,
          },
        });
        ctx.timers.start(
          'T1.reminder',
          new Date(
            ctx.now.getTime() + (expiry.getTime() - ctx.now.getTime()) * 0.75,
          ),
          assignment.id,
        );
        ctx.timers.start('T1.expire', expiry, assignment.id);
        ctx.audit('Assignment offered', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note: dto.note,
          changes: {
            providerId: choice.provider.id,
            source: 'auto',
            score: choice.total,
          },
        });
        ctx.notify('assignment.offered', {
          assignmentId: assignment.id,
          providerUserId: choice.provider.userId,
          requestCode: ctx.snap.number,
          service: request.service,
          district: ctx.snap.districtName ?? '',
          skill: dispatchRequest.skill ?? request.service,
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
      share?: { description: string; attachmentIds: string[] };
      overrideNote?: string;
    },
    version: number,
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
        const assignment = await ctx.tx.assignment.findFirst({
          where: { id: assignmentId, requestId: ctx.snap.id },
        });
        if (!assignment || assignment.status !== 'pending_approval')
          throw conflict('This assignment is no longer awaiting approval.');
        if (!dto.approve) {
          const note = dto.note?.trim() ?? '';
          if (note.length < 3)
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              'Explain why the assignment is not confirmed.',
            );
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
          ctx.audit('Assignment acceptance rejected', {
            resourceType: 'assignment',
            resourceId: assignment.id,
            note,
          });
          if (
            ctx.snap.currentAssignment?.status === 'pending_approval' &&
            ctx.snap.status === 'under_review'
          )
            ctx.enqueueCascade('cascade');
          else
            ctx.notify('request.needs_manual_assignment', {
              requestCode: ctx.snap.number,
            });
          return;
        }
        const provider = await this.providers
          .list(ctx.now, ctx.snap.id)
          .then((rows) =>
            rows.find((item) => item.id === assignment.providerId),
          );
        const requestRow = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!provider || !requestRow)
          throw conflict(
            'The provider is no longer available. Refresh the request.',
          );
        const eligibility = evaluateEligibility(
          provider,
          this.toDispatchRequest(requestRow),
          {
            requireVerifiedBank:
              ctx.settings['assignment.requireVerifiedBank'] !== false,
          },
        );
        if (!eligibility.eligible) {
          if (!OVERRIDABLE_RULES.includes(eligibility.rule))
            throw conflict(
              `${provider.name} can no longer take this job (${eligibility.reason}).`,
            );
          if (!dto.overrideNote?.trim())
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              `Add an override note to confirm this assignment: ${eligibility.reason}.`,
            );
        }
        const updated = await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'accepted',
            reviewedBy: userId,
            reviewedAt: ctx.now,
            reviewNote: dto.note?.trim() || null,
            sharedDetails: dto.share,
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
        if (!acceptedQuote) {
          ctx.timers.start(
            'T7.reminder24h',
            new Date(ctx.now.getTime() + 24 * 60 * 60 * 1000),
            assignment.id,
          );
          ctx.timers.start(
            'T7.stall48h',
            new Date(ctx.now.getTime() + 48 * 60 * 60 * 1000),
            assignment.id,
          );
        }
        const quoteForPayout =
          acceptedQuote ??
          (await ctx.tx.quote.findFirst({
            where: { requestId: ctx.snap.id },
            orderBy: { version: 'desc' },
          }));
        if (
          quoteForPayout?.payoutAmount &&
          !(await ctx.tx.payout.findFirst({
            where: {
              requestId: ctx.snap.id,
              assignmentId: assignment.id,
              kind: 'primary',
            },
          }))
        ) {
          const currentBank = await ctx.tx.providerBankAccount.findFirst({
            where: { providerId: assignment.providerId, state: 'verified' },
            orderBy: { reviewedAt: 'desc' },
          });
          const payoutHold =
            ctx.snap.hold ||
            ctx.snap.openIssues.length > 0 ||
            provider.userStatus === 'suspended';
          await ctx.tx.payout.create({
            data: {
              requestId: ctx.snap.id,
              assignmentId: assignment.id,
              providerId: assignment.providerId,
              kind: 'primary',
              amount: quoteForPayout.payoutAmount,
              status: payoutHold ? 'on_hold' : 'pending_approval',
              holdReason: payoutHold
                ? 'Open request issue, hold, or provider suspension.'
                : null,
              holdSource: payoutHold ? 'dispatch_review' : null,
              approvalDueAt: addWorkingMinutes(ctx.now, 20 * 60),
              bankAccountId: currentBank?.id ?? null,
            },
          });
        }
        ctx.audit('Assignment confirmed', {
          resourceType: 'assignment',
          resourceId: updated.id,
          note: dto.note,
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
    version: number,
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
            status: { in: ['offered', 'pending_approval'] },
          },
        });
        if (!assignment) throw conflict('This offer is no longer current.');
        if (
          await ctx.tx.quote.findFirst({
            where: { requestId: ctx.snap.id, status: 'accepted' },
          })
        )
          throw conflict(
            'This provider has an accepted quote. Replace the provider instead.',
          );
        if (!note.trim())
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a note for withdrawing this offer.',
          );
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
          ['T1.reminder', 'T1.expire', 'T3.review'],
          assignment.id,
        );
        ctx.audit('Assignment withdrawn', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note,
        });
        ctx.notify('request.offer_withdrawn', {
          assignmentId: assignment.id,
          providerUserId: assignment.providerUserId,
          requestCode: ctx.snap.number,
          service: '',
          district: '',
        });
      },
    );
  }

  async replace(
    userId: string,
    ref: string,
    assignmentId: string,
    dto: { note: string; workStarted?: boolean },
    version: number,
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
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            id: assignmentId,
            requestId: ctx.snap.id,
            status: 'accepted',
          },
        });
        if (!assignment)
          throw conflict('This provider is no longer assigned to the request.');
        if (
          !(await ctx.tx.quote.findFirst({
            where: { requestId: ctx.snap.id, status: 'accepted' },
          }))
        )
          throw conflict(
            'Create or accept a quote before replacing this provider.',
          );
        if (ctx.snap.hold || ctx.snap.openIssues.length)
          throw conflict(
            'Resolve the current hold or issue before replacing the provider.',
          );
        const note = dto.note.trim();
        if (!note)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a note explaining why this provider is being replaced.',
          );
        await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: 'replaced',
            endReason: 'replaced',
            endedAt: ctx.now,
            endedBy: userId,
            workStarted: dto.workStarted ?? assignment.workStarted,
          },
        });
        await ctx.tx.quote.updateMany({
          where: {
            requestId: ctx.snap.id,
            status: { in: ['accepted', 'sent'] },
          },
          data: { providerChangedAt: ctx.now },
        });
        await ctx.tx.schedule.updateMany({
          where: {
            requestId: ctx.snap.id,
            status: { in: ['proposed', 'changes_requested'] },
          },
          data: { status: 'cancelled' },
        });
        await ctx.tx.payout.updateMany({
          where: {
            assignmentId: assignment.id,
            status: {
              in: ['pending_approval', 'awaiting_second_approval', 'approved'],
            },
          },
          data: {
            status: 'on_hold',
            holdReason: 'Provider replaced on this request.',
            holdSource: userId,
          },
        });
        await ctx.tx.serviceRequest.update({
          where: { id: ctx.snap.id },
          data: { status: 'under_review', needsAssignmentReason: 'replaced' },
        });
        ctx.audit('Assignment replaced', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note,
          changes: { workStarted: dto.workStarted ?? assignment.workStarted },
        });
      },
    );
  }

  async shareDetails(
    userId: string,
    ref: string,
    dto: { attachmentIds?: string[]; fields?: string[]; note?: string },
    version: number,
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
        if (
          fields.some((field) => field === 'address' || field === 'access') &&
          !dto.note?.trim()
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a note explaining why the provider needs the site details before the date is confirmed.',
          );
        const existing = object(assignment.sharedDetails);
        const nextFields = [
          ...new Set([
            ...(Array.isArray(existing.fields)
              ? existing.fields.filter(
                  (item): item is string => typeof item === 'string',
                )
              : []),
            ...fields,
          ]),
        ];
        const nextAttachments = [
          ...new Set([
            ...(Array.isArray(existing.attachmentIds)
              ? existing.attachmentIds.filter(
                  (item): item is string => typeof item === 'string',
                )
              : []),
            ...(dto.attachmentIds ?? []),
          ]),
        ];
        await ctx.tx.assignment.update({
          where: { id: assignment.id },
          data: {
            sharedDetails: {
              fields: nextFields,
              attachmentIds: nextAttachments,
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
          changes: { fields, attachmentIds: dto.attachmentIds ?? [] },
        });
      },
    );
  }

  async setMode(
    userId: string,
    ref: string,
    dto: { mode: 'auto' | 'manual'; note: string },
    version: number,
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
        if (note.length < 5)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a note explaining the change.',
          );
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
      overrideRules?: string[];
      overrideNote?: string;
    },
    version: number,
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
          throw conflict('Refresh the ranked list.');
        const provider = await this.providers
          .list(ctx.now, ctx.snap.id)
          .then((rows) => rows.find((item) => item.id === dto.providerId));
        if (!provider)
          throw conflict(
            'The provider is no longer available. Refresh the ranked list.',
          );
        const profile = await ctx.tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${dto.providerId} FOR UPDATE`,
        );
        if (!profile.length)
          throw conflict(
            'The provider is no longer available. Refresh the ranked list.',
          );
        const request = await ctx.tx.serviceRequest.findUnique({
          where: { id: ctx.snap.id },
        });
        if (!request) throw requestNotFound();
        const eligibility = evaluateEligibility(
          provider,
          this.toDispatchRequest(request),
          {
            requireVerifiedBank:
              ctx.settings['assignment.requireVerifiedBank'] !== false,
          },
        );
        const overridden = eligibility.eligible ? [] : [eligibility.rule];
        if (
          !eligibility.eligible &&
          !OVERRIDABLE_RULES.includes(eligibility.rule)
        )
          throw conflict(
            `${provider.name} can no longer take this job (${eligibility.reason}). Refresh the ranked list.`,
          );
        if (
          !eligibility.eligible &&
          (!dto.overrideRules?.includes(eligibility.rule) ||
            !dto.overrideNote?.trim())
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `Select ${eligibility.rule} and add an override note to continue: ${eligibility.reason}.`,
          );
        if (
          dto.overrideRules?.some(
            (rule) =>
              !OVERRIDABLE_RULES.includes(
                rule as (typeof OVERRIDABLE_RULES)[number],
              ),
          )
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Only area, day, skill, capacity, previous and bank rules can be overridden.',
          );
        const matched = (
          run.eligible as Array<{
            providerId: string;
            total: number;
            factors: Record<string, number>;
          }>
        ).find((item) => item.providerId === provider.id);
        const rankingScore = matched ?? { total: 0, factors: {} };
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
            attempt: request.autoAttempts + 1,
            rankingRunId: run.id,
            score: { total: rankingScore.total, factors: rankingScore.factors },
            overrideNote: dto.overrideNote?.trim() || null,
            overriddenRules: overridden,
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
        ctx.audit('Assignment offered', {
          resourceType: 'assignment',
          resourceId: assignment.id,
          note: dto.note,
          changes: { providerId: provider.id, source: 'manual' },
        });
        if (overridden.length)
          ctx.audit('Dispatch suggestion overridden', {
            resourceType: 'assignment',
            resourceId: assignment.id,
            note: dto.overrideNote,
            changes: { rules: overridden },
          });
        ctx.notify('assignment.offered', {
          assignmentId: assignment.id,
          providerUserId: provider.userId,
          requestCode: ctx.snap.number,
          service: request.service,
          district: ctx.snap.districtName ?? '',
          skill: this.toDispatchRequest(request).skill ?? request.service,
        });
      },
    );
  }

  async respond(
    userId: string,
    ref: string,
    assignmentId: string,
    dto: { accept: boolean; note?: string; crewSize?: number },
    version: number,
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
        if (!assignment || assignment.status !== 'offered')
          throw conflict('This offer is no longer awaiting your response.');
        if (ctx.now >= assignment.expiresAt)
          throw conflict('This offer has expired.');
        if (!dto.accept) {
          const note = dto.note?.trim() ?? '';
          if (note.length < 3)
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              'Add a reason for declining.',
            );
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
        if (
          !profile ||
          profile.verification !== 'approved' ||
          !profile.available ||
          profile.user.status !== 'active'
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
        ctx.timers.start(
          'T3.review',
          new Date(ctx.now.getTime() + 4 * 60 * 60 * 1000),
          assignment.id,
        );
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
  private toDispatchRequest(row: {
    id: string;
    ownerId: string;
    service: string;
    districtId: string;
    cityId: string;
    districtName?: string | null;
    startDate: string | null;
    details: unknown;
  }): DispatchRequest {
    const details = object(row.details);
    const skillField = (
      intakeFields[row.service as (typeof serviceLines)[number]] ?? []
    ).find((field) => field.isSkill);
    const skill = skillField
      ? String(details[skillField.key] ?? '') || null
      : null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      service: row.service,
      skill,
      districtId: row.districtId,
      districtName: row.districtName ?? row.districtId,
      cityId: row.cityId,
      effectiveStartDate: row.startDate,
      effectiveEndDate:
        typeof details.endDate === 'string' ? details.endDate : null,
    };
  }
  private run(
    actor: ActorContext,
    command: string,
    ref: string,
    version: number,
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
