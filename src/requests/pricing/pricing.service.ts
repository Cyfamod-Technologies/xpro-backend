import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
  requireProvider,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner, type CommandContext } from '../command-runner';

type Line = { description: string; quantity: number; unitPrice: number };
const fail = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);
const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const sumItems = (items: Line[]) => {
  if (
    !items.length ||
    items.some(
      (item) =>
        !item.description.trim() || item.quantity <= 0 || item.unitPrice <= 0,
    )
  )
    throw fail(
      'Add a description, positive quantity and unit price for every line item.',
    );
  const total = items.reduce(
    (sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitPrice),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw fail('The quote total is too large.');
  return total;
};
const jsonItems = (items: Line[]) =>
  items.map((item) => ({
    description: item.description.trim(),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  })) as Prisma.InputJsonArray;

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
  ) {}

  async listContributions(user: RequestUser, ref: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findRequest(ref);
    if (actor.kind === 'staff') requirePermission(actor, 'view.pricing');
    else if (actor.kind !== 'provider')
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );
    const current = await this.prisma.assignment.findFirst({
      where: {
        requestId: request.id,
        status: 'accepted',
        ...(actor.kind === 'provider' ? { providerUserId: user.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const rows = current
      ? await this.prisma.contribution.findMany({
          where: {
            requestId: request.id,
            ...(actor.kind === 'provider' ? { assignmentId: current.id } : {}),
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    return rows.map((row) => ({ ...row, total: Number(row.total) }));
  }

  async contribute(
    user: RequestUser,
    ref: string,
    dto: { items: Line[]; note?: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireProvider(actor);
    return this.run(
      actor,
      'quote.contribute',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const assignment = await ctx.tx.assignment.findFirst({
          where: {
            requestId: ctx.snap.id,
            providerUserId: user.id,
            status: 'accepted',
          },
          orderBy: { createdAt: 'desc' },
        });
        if (!assignment)
          throw conflict(
            'Accept the current assignment before updating this job.',
          );
        if (
          [
            'in_progress',
            'blocked',
            'completion_pending',
            'acknowledged',
            'closed',
          ].includes(ctx.snap.status)
        )
          throw conflict("Costing can't change once work has started.");
        const total = sumItems(dto.items);
        await ctx.tx.contribution.create({
          data: {
            requestId: ctx.snap.id,
            assignmentId: assignment.id,
            providerId: assignment.providerId,
            items: jsonItems(dto.items),
            total,
            note: dto.note?.trim() || null,
          },
        });
        ctx.timers.stop(['T7.reminder24h', 'T7.stall48h'], assignment.id);
        ctx.audit('Provider pricing submitted', {
          resourceType: 'contribution',
          note: dto.note,
          changes: { total: Number(total), assignmentId: assignment.id },
        });
        ctx.notify('quote.contribution_submitted', {
          requestCode: ctx.snap.number,
        });
      },
    );
  }

  async listQuotes(user: RequestUser, ref: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findRequest(ref);
    if (actor.kind === 'staff') requirePermission(actor, 'quote.manage');
    else if (user.id !== request.ownerId && actor.kind !== 'provider')
      throw new AppError(
        404,
        'NOT_FOUND',
        'This request is no longer available to your account.',
      );
    const rows = await this.prisma.quote.findMany({
      where: { requestId: request.id },
      orderBy: { version: 'desc' },
    });
    return rows.map((row) => ({
      ...row,
      total: Number(row.total),
      payoutAmount: row.payoutAmount == null ? null : Number(row.payoutAmount),
    }));
  }

  async saveQuote(
    userId: string,
    ref: string,
    dto: { quoteId?: string; revision?: number; items: Line[]; note?: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'quote.manage');
    return this.run(
      actor,
      'quote.save',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        if (ctx.snap.payment.paid)
          throw conflict(
            'This job is paid. Change the price through a variation.',
          );
        if (
          !['matched', 'quoted', 'awaiting_payment'].includes(ctx.snap.status)
        )
          throw conflict(
            'Quotes can only be prepared once a provider is confirmed.',
          );
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        if (!assignment)
          throw conflict(
            'Confirm a provider assignment before preparing a quote.',
          );
        const total = sumItems(dto.items);
        let row;
        if (dto.quoteId) {
          row = await ctx.tx.quote.findFirst({
            where: { id: dto.quoteId, requestId: ctx.snap.id },
          });
          if (!row) throw conflict('This quote version no longer exists.');
          if (row.status !== 'draft')
            throw conflict(
              'Published quote versions cannot be edited. Create a new version.',
            );
          if (row.revision !== dto.revision)
            throw conflict(
              'This quote changed since you opened it. Reload and review the latest version.',
            );
          row = await ctx.tx.quote.update({
            where: { id: row.id },
            data: {
              revision: { increment: 1 },
              items: jsonItems(dto.items),
              total,
              note: dto.note?.trim() || null,
              lastEditedBy: userId,
              approvalRequestedAt: null,
              approvalRequestedBy: null,
            },
          });
        } else {
          const latest = await ctx.tx.quote.findFirst({
            where: { requestId: ctx.snap.id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          row = await ctx.tx.quote.create({
            data: {
              requestId: ctx.snap.id,
              version: (latest?.version ?? 0) + 1,
              revision: 1,
              items: jsonItems(dto.items),
              total,
              note: dto.note?.trim() || null,
              lastEditedBy: userId,
              basedOnAssignmentId: assignment.id,
            },
          });
        }
        ctx.audit('Quote draft saved', {
          resourceType: 'quote',
          resourceId: row.id,
          changes: { version: row.version, revision: row.revision },
        });
      },
    );
  }

  async publish(
    userId: string,
    ref: string,
    quoteId: string,
    dto: {
      revision: number;
      pricingOverrideNote?: string;
      customerNote?: string;
    },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'quote.manage');
    return this.run(
      actor,
      'quote.publish',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => this.publishWithin(ctx, quoteId, dto, userId),
    );
  }

  async approve(
    userId: string,
    ref: string,
    quoteId: string,
    dto: { revision: number; selfApprovalReason?: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'quote.approve');
    return this.run(
      actor,
      'quote.approve',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: { id: quoteId, requestId: ctx.snap.id },
        });
        if (!quote || !quote.approvalRequestedAt)
          throw conflict('This quote is not awaiting approval.');
        if (quote.revision !== dto.revision)
          throw conflict(
            'This quote changed since you opened it. Reload and review the latest version.',
          );
        if (quote.lastEditedBy === userId && !actor.staff?.isSuperAdmin)
          throw conflict(
            'You edited this quote last. Another approver must sign it off.',
          );
        if (
          quote.lastEditedBy === userId &&
          actor.staff?.isSuperAdmin &&
          !dto.selfApprovalReason?.trim()
        )
          throw fail('Add a reason for approving your own quote.');
        await this.publishWithin(
          ctx,
          quoteId,
          { revision: dto.revision },
          userId,
          true,
        );
        await ctx.tx.quote.update({
          where: { id: quoteId },
          data: {
            approvedBy: userId,
            selfApproved: quote.lastEditedBy === userId,
          },
        });
        ctx.audit('Quote approved', {
          resourceType: 'quote',
          resourceId: quoteId,
          note: dto.selfApprovalReason,
          changes: { selfApproved: quote.lastEditedBy === userId },
        });
      },
    );
  }

  async returnQuote(
    userId: string,
    ref: string,
    quoteId: string,
    dto: { revision: number; note: string },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'quote.approve');
    return this.run(
      actor,
      'quote.return',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: { id: quoteId, requestId: ctx.snap.id },
        });
        if (!quote?.approvalRequestedAt)
          throw conflict('This quote is not awaiting approval.');
        if (quote.revision !== dto.revision)
          throw conflict(
            'This quote changed since you opened it. Reload and review the latest version.',
          );
        await ctx.tx.quote.update({
          where: { id: quoteId },
          data: {
            approvalRequestedBy: null,
            approvalRequestedAt: null,
            returnedNote: dto.note.trim(),
          },
        });
        ctx.audit('Quote returned', {
          resourceType: 'quote',
          resourceId: quoteId,
          note: dto.note,
        });
        ctx.notify('quote.returned', {
          requestCode: ctx.snap.number,
          note: dto.note,
        });
      },
    );
  }

  async respond(
    user: RequestUser,
    ref: string,
    quoteId: string,
    dto: {
      decision: 'accepted' | 'revision_requested' | 'declined';
      note?: string;
    },
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requireCustomer(actor);
    return this.run(
      actor,
      'quote.respond',
      ref,
      version,
      url,
      dto,
      key,
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: { id: quoteId, requestId: ctx.snap.id },
          orderBy: { version: 'desc' },
        });
        if (
          !quote ||
          quote.status !== 'sent' ||
          ctx.snap.latestQuote?.version !== quote.version
        )
          throw conflict(
            'This quote has already changed or received a response.',
          );
        if (!quote.validUntil || ctx.now >= quote.validUntil)
          throw conflict(
            'This quote has expired. XPro will send you a new one.',
          );
        if (dto.decision !== 'accepted' && !dto.note?.trim())
          throw fail('Explain the decline or revision request.');
        if (dto.decision === 'accepted') {
          const dueAt = new Date(ctx.now.getTime() + 7 * 86_400_000);
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'accepted',
              acceptedAt: ctx.now,
              paymentDueAt: dueAt,
              responseNote: dto.note?.trim() || null,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'awaiting_payment' },
          });
          ctx.timers.stop(
            ['T8.reminder3d', 'T8.reminder1d', 'T8.expire'],
            quote.id,
          );
          ctx.timers.start(
            'T9.reminder24h',
            new Date(ctx.now.getTime() + 24 * 60 * 60 * 1000),
            quote.id,
          );
          ctx.timers.start(
            'T9.reminder72h',
            new Date(ctx.now.getTime() + 72 * 60 * 60 * 1000),
            quote.id,
          );
          ctx.timers.start('T9.lapse', dueAt, quote.id);
          ctx.audit('Quote accepted', {
            resourceType: 'quote',
            resourceId: quote.id,
          });
        } else if (dto.decision === 'revision_requested') {
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'revision_requested',
              respondedAt: ctx.now,
              responseNote: dto.note,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'matched' },
          });
          ctx.timers.stop(
            ['T8.reminder3d', 'T8.reminder1d', 'T8.expire'],
            quote.id,
          );
          ctx.audit('Quote revision requested', {
            resourceType: 'quote',
            resourceId: quote.id,
            note: dto.note,
          });
          ctx.notify('quote.revision_requested', {
            requestCode: ctx.snap.number,
            note: dto.note,
          });
        } else {
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'declined',
              respondedAt: ctx.now,
              responseNote: dto.note,
            },
          });
          await ctx.tx.cancellation.create({
            data: {
              requestId: ctx.snap.id,
              requestedBy: 'customer',
              requestedById: user.id,
              reasonCode: 'quote_declined',
              note: dto.note!,
              stage: 'quoted',
            },
          });
          ctx.timers.stop(
            ['T8.reminder3d', 'T8.reminder1d', 'T8.expire'],
            quote.id,
          );
          ctx.audit('Quote declined', {
            resourceType: 'quote',
            resourceId: quote.id,
            note: dto.note,
          });
        }
      },
    );
  }

  async setPayout(
    userId: string,
    ref: string,
    quoteId: string,
    amount: number,
    version: number,
    url: string,
    key?: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'quote.manage');
    requirePermission(actor, 'view.pricing');
    return this.run(
      actor,
      'quote.setPayout',
      ref,
      version,
      url,
      { amount },
      key,
      async (ctx) => {
        const quote = await ctx.tx.quote.findFirst({
          where: {
            id: quoteId,
            requestId: ctx.snap.id,
            status: { in: ['draft', 'sent', 'accepted'] },
          },
        });
        if (!quote) throw conflict('This quote version no longer exists.');
        if (
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          BigInt(amount) > quote.total
        )
          throw fail(
            'Enter a payout amount above 0 and no higher than the quote total.',
          );
        const assignment = await ctx.tx.assignment.findFirst({
          where: { requestId: ctx.snap.id, status: 'accepted' },
          orderBy: { createdAt: 'desc' },
        });
        await ctx.tx.quote.update({
          where: { id: quote.id },
          data: {
            payoutAmount: BigInt(amount),
            payoutAssignmentId: assignment?.id ?? null,
          },
        });
        ctx.audit('Provider payout amount changed', {
          resourceType: 'quote',
          resourceId: quote.id,
          changes: { payoutAmount: amount },
        });
      },
    );
  }

  private async publishWithin(
    ctx: CommandContext,
    quoteId: string,
    dto: {
      revision: number;
      pricingOverrideNote?: string;
      customerNote?: string;
    },
    userId: string,
    approved = false,
  ): Promise<void | { status: number }> {
    const quote = await ctx.tx.quote.findFirst({
      where: { id: quoteId, requestId: ctx.snap.id },
    });
    if (!quote || quote.status !== 'draft')
      throw conflict(
        'Publish the latest draft version. Older drafts cannot replace newer quotes.',
      );
    const latest = await ctx.tx.quote.findFirst({
      where: { requestId: ctx.snap.id },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== quote.id)
      throw conflict(
        'Publish the latest draft version. Older drafts cannot replace newer quotes.',
      );
    if (quote.revision !== dto.revision)
      throw conflict(
        'This quote changed since you opened it. Reload and review the latest version.',
      );
    const assignment = await ctx.tx.assignment.findFirst({
      where: { requestId: ctx.snap.id, status: 'accepted' },
      orderBy: { createdAt: 'desc' },
    });
    if (!assignment)
      throw conflict(
        'Confirm a provider assignment before publishing the quote.',
      );
    if (ctx.snap.payment.paid)
      throw conflict('This job is paid. Change the price through a variation.');
    const pending = await ctx.tx.payment.findFirst({
      where: {
        requestId: ctx.snap.id,
        quoteId: quote.id,
        status: 'pending',
        createdAt: { gte: new Date(ctx.now.getTime() - 30 * 60_000) },
      },
    });
    if (pending)
      throw conflict(
        'A payment is in progress for the current quote. Try again once it settles.',
      );
    const contribution = await ctx.tx.contribution.findFirst({
      where: { requestId: ctx.snap.id, assignmentId: assignment.id },
    });
    if (!contribution && !dto.pricingOverrideNote?.trim())
      throw conflict(
        "Get the provider's costing first, or add a pricing override note.",
      );
    if (
      quote.basedOnAssignmentId &&
      quote.basedOnAssignmentId !== assignment.id &&
      !dto.pricingOverrideNote?.trim()
    )
      throw conflict(
        'This draft was prepared for the previous provider. Add a note to publish it anyway.',
      );
    if (ctx.snap.status === 'awaiting_payment' && !dto.customerNote?.trim())
      throw fail('Add a note for the customer explaining the new version.');
    const threshold = ctx.settings['quote.approvalThreshold'];
    const requiresApproval =
      !approved &&
      threshold != null &&
      Number(quote.total) >= Number(threshold) &&
      !ctx.actor.staff?.permissions.has('quote.approve');
    if (requiresApproval) {
      await ctx.tx.quote.update({
        where: { id: quote.id },
        data: {
          approvalRequestedBy: userId,
          approvalRequestedAt: ctx.now,
          pricingOverrideNote: dto.pricingOverrideNote?.trim() || null,
        },
      });
      ctx.audit('Quote approval requested', {
        resourceType: 'quote',
        resourceId: quote.id,
      });
      ctx.notify('quote.approval_needed', { requestCode: ctx.snap.number });
      return { status: 202 };
    }
    const validDays = Number(ctx.settings['quote.validityDays'] ?? 14);
    const validUntil = new Date(ctx.now.getTime() + validDays * 86_400_000);
    await ctx.tx.quote.update({
      where: { id: quote.id },
      data: {
        status: 'sent',
        publishedBy: userId,
        publishedAt: ctx.now,
        validUntil,
        pricingOverrideNote: dto.pricingOverrideNote?.trim() || null,
        approvalRequestedBy: null,
        approvalRequestedAt: null,
      },
    });
    await ctx.tx.quote.updateMany({
      where: {
        requestId: ctx.snap.id,
        id: { not: quote.id },
        status: { in: ['sent', 'accepted'] },
      },
      data: { status: 'superseded' },
    });
    await ctx.tx.serviceRequest.update({
      where: { id: ctx.snap.id },
      data: { status: 'quoted' },
    });
    ctx.timers.stop([
      'T7.reminder24h',
      'T7.stall48h',
      'T9.reminder24h',
      'T9.reminder72h',
      'T9.lapse',
    ]);
    ctx.timers.start(
      'T8.reminder3d',
      new Date(validUntil.getTime() - 3 * 86_400_000),
      quote.id,
    );
    ctx.timers.start(
      'T8.reminder1d',
      new Date(validUntil.getTime() - 86_400_000),
      quote.id,
    );
    ctx.timers.start('T8.expire', validUntil, quote.id);
    ctx.notify('quote.ready', {
      requestCode: ctx.snap.number,
      note: dto.customerNote,
    });
    ctx.audit(approved ? 'Quote approved and published' : 'Quote published', {
      resourceType: 'quote',
      resourceId: quote.id,
      changes: { version: quote.version },
    });
  }

  private findRequest(ref: string) {
    const number = /^XPR-(\d+)$/i.exec(ref)?.[1];
    return number
      ? this.prisma.serviceRequest
          .findUnique({ where: { number: Number(number) } })
          .then((row) => {
            if (!row)
              throw new AppError(
                404,
                'NOT_FOUND',
                'This request is no longer available to your account.',
              );
            return row;
          })
      : this.prisma.serviceRequest
          .findUnique({ where: { id: ref } })
          .then((row) => {
            if (!row)
              throw new AppError(
                404,
                'NOT_FOUND',
                'This request is no longer available to your account.',
              );
            return row;
          });
  }

  private run(
    actor: Awaited<ReturnType<ActorService['resolve']>>,
    command: string,
    ref: string,
    version: number,
    url: string,
    body: unknown,
    key: string | undefined,
    fn: (ctx: CommandContext) => Promise<void | { status?: number }>,
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
