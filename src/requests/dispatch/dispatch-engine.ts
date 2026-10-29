import { Prisma, type DispatchTrigger } from '@prisma/client';
import { AppError } from '../../platform/errors/app-error';
import { SETTINGS_REGISTRY } from '../../platform/settings/settings.registry';
import type { CommandContext } from '../command-runner';
import { noLongerAvailableMessage } from '../domain/assignment-rules';
import {
  dispatchRequestFor,
  type DispatchRequestRow,
} from '../domain/dispatch-request';
import {
  evaluateEligibility,
  type DispatchProvider,
  type DispatchRequest,
} from '../domain/eligibility';
import { offerExpiry } from '../domain/offer-expiry';
import {
  rankProviders,
  type DispatchWeights,
  type RankedProvider,
} from '../domain/ranking';
import type { ProviderDispatchLoader } from './provider-dispatch.loader';

export type AutoDispatchInput = {
  trigger: DispatchTrigger;
  /** The staff member for `staff_auto`; `null` for the system and the cascade. */
  actorId: string | null;
  request: DispatchRequestRow;
  /** Automatic offers made so far, after any reset (04 §6.6). */
  attemptsBefore: number;
  /** Internal staff note: kept in the audit only, never on the assignment the provider sees (B-24). */
  note?: string;
};

/**
 * One automatic run (04 §6.6): evaluate every provider at `ctx.now`, store the
 * `DispatchRun` with every score and exclusion, then offer the top candidate.
 * The offer takes `SELECT … FOR UPDATE` on the candidate's profile and
 * re-evaluates the rules from fresh data in the same transaction (capacity
 * locking, REQ-13a). A system run whose candidate no longer qualifies moves to
 * the next provider of the same run; a staff run gets the 409.
 */
export async function runAutoDispatch(
  providers: ProviderDispatchLoader,
  ctx: CommandContext,
  input: AutoDispatchInput,
): Promise<{ offered: boolean }> {
  const { request } = input;
  const dispatchRequest = await dispatchRequestFor(ctx.tx, request, {
    districtName: ctx.snap.districtName,
    cityName: ctx.snap.cityName,
  });
  const options = {
    requireVerifiedBank:
      ctx.settings['assignment.requireVerifiedBank'] !== false,
  };
  const candidates = await providers.list(ctx.now, request.id, ctx.tx);
  const excluded: Array<Record<string, string>> = [];
  const eligible = candidates.filter((candidate) => {
    const result = evaluateEligibility(candidate, dispatchRequest, options);
    if (!result.eligible)
      excluded.push({
        providerId: candidate.id,
        providerName: candidate.name,
        rule: result.rule,
        reason: result.reason,
      });
    return result.eligible;
  });
  const ranked = rankProviders(
    eligible,
    dispatchRequest,
    (ctx.settings['assignment.weights'] ??
      SETTINGS_REGISTRY['assignment.weights'].defaultValue) as DispatchWeights,
    ctx.now,
  );
  const run = await ctx.tx.dispatchRun.create({
    data: {
      requestId: request.id,
      trigger: input.trigger,
      actorId: input.actorId,
      at: ctx.now,
      settings: ctx.settings as Prisma.InputJsonValue,
      eligible: ranked.map(({ provider, total, factors }) => ({
        providerId: provider.id,
        providerName: provider.name,
        total,
        factors,
      })),
      excluded,
    },
  });

  for (const candidate of ranked) {
    const locked = await ctx.tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM provider_profiles WHERE id = ${candidate.provider.id} FOR UPDATE`,
    );
    const fresh = locked.length
      ? await providers.one(candidate.provider.id, ctx.now, request.id, ctx.tx)
      : null;
    const recheck = fresh
      ? evaluateEligibility(fresh, dispatchRequest, options)
      : null;
    if (fresh && recheck?.eligible) {
      await makeOffer(ctx, input, dispatchRequest, run.id, candidate, fresh);
      return { offered: true };
    }
    if (input.actorId)
      throw new AppError(
        409,
        'STATE_CONFLICT',
        recheck && !recheck.eligible
          ? noLongerAvailableMessage(
              fresh?.name ?? candidate.provider.name,
              recheck.reason,
            )
          : 'The provider is no longer available. Refresh the ranked list.',
      );
  }

  await ctx.tx.serviceRequest.update({
    where: { id: request.id },
    data: {
      needsAssignmentReason: 'no_eligible',
      lastRunId: run.id,
      autoAttempts: input.attemptsBefore,
    },
  });
  ctx.approvals.open('needs_assignment', request.id);
  ctx.audit('Automatic assignment needs staff', {
    note: input.note,
    changes: { reason: 'no_eligible', runId: run.id },
  });
  ctx.notify('request.needs_manual_assignment', {
    requestCode: ctx.snap.number,
  });
  return { offered: false };
}

async function makeOffer(
  ctx: CommandContext,
  input: AutoDispatchInput,
  dispatchRequest: DispatchRequest,
  runId: string,
  choice: RankedProvider,
  fresh: DispatchProvider,
): Promise<void> {
  const expiry = offerExpiry(
    ctx.now,
    Number(ctx.settings['assignment.offerExpiryHours'] ?? 24),
    Number(ctx.settings['assignment.offerMinWorkingHours'] ?? 4),
    fresh.workingHours,
    fresh.timeOff,
  );
  const assignment = await ctx.tx.assignment.create({
    data: {
      requestId: input.request.id,
      providerId: fresh.id,
      providerUserId: fresh.userId,
      status: 'offered',
      source: 'auto',
      attempt: input.attemptsBefore + 1,
      rankingRunId: runId,
      score: { total: choice.total, factors: choice.factors },
      offeredAt: ctx.now,
      expiresAt: expiry,
    },
  });
  await ctx.tx.providerProfile.update({
    where: { id: fresh.id },
    data: { lastOfferedAt: ctx.now },
  });
  await ctx.tx.serviceRequest.update({
    where: { id: input.request.id },
    data: {
      autoAttempts: input.attemptsBefore + 1,
      needsAssignmentReason: null,
      lastRunId: runId,
    },
  });
  ctx.timers.start(
    'T1.reminder',
    new Date(ctx.now.getTime() + (expiry.getTime() - ctx.now.getTime()) * 0.75),
    assignment.id,
  );
  ctx.timers.start('T1.expire', expiry, assignment.id);
  ctx.approvals.close('needs_assignment', input.request.id, 'offered');
  ctx.audit('Assignment offered', {
    resourceType: 'assignment',
    resourceId: assignment.id,
    note: input.note,
    changes: { providerId: fresh.id, source: 'auto', score: choice.total },
  });
  ctx.notify('assignment.offered', {
    assignmentId: assignment.id,
    providerUserId: fresh.userId,
    requestCode: ctx.snap.number,
    service: input.request.service,
    district: ctx.snap.districtName ?? '',
    skill: dispatchRequest.skill ?? input.request.service,
  });
}
