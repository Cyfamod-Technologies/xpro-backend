import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../platform/actor/actor.service';
import {
  requireActiveStaff,
  requireCustomer,
  requirePermission,
  requireProvider,
} from '../../platform/actor/actor.guards';
import { AppError } from '../../platform/errors/app-error';
import { hashRequest } from '../../platform/idempotency/idempotency.service';
import { TimerKinds } from '../../platform/timers/timer-kinds';
import { PrismaService } from '../../prisma/prisma.service';
import type { StaffPermission } from '../../staff/staff-permissions';
import type { RequestUser } from '../../common/types/request-user';
import { RequestCommandRunner, type CommandContext } from '../command-runner';
import { confirmedAssignmentIds } from '../domain/quote-access';
import { quoteItemsTotal } from '../domain/quote-items';
import { requiresSignOff, selfApprovalFailure } from '../domain/quote-signoff';
import {
  customerQuoteView,
  payoutSuggestion,
  providerContributionView,
  providerQuoteView,
  staffContributionView,
  staffQuoteView,
} from '../projections/quote.projection';
import { resolveRequestId } from '../request-ref';

type Line = { description: string; quantity: number; unitPrice: number };
const fail = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);
const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const notFound = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This request is no longer available to your account.',
  );
const QUOTE_GONE = 'This quote version no longer exists.';
const DAY_MS = 86_400_000;
/** Staff who may read the quote list; `view.pricing` alone decides whether amounts are masked. */
const QUOTE_READERS: StaffPermission[] = [
  'quote.manage',
  'quote.approve',
  'view.pricing',
];
/** The runner guard already validated the lines (04 §6.10/§6.11); this computes the stored total. */
const sumItems = (items: Line[]) => {
  const result = quoteItemsTotal(items);
  if (!result.ok)
    throw new AppError(result.status, result.code, result.message);
  return result.total;
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
    if (actor.kind === 'staff') {
      requireActiveStaff(actor);
      const canSeePricing = actor.staff.permissions.has('view.pricing');
      const rows = await this.prisma.contribution.findMany({
        where: { requestId: request.id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => ({
        id: row.id,
        assignmentId: row.assignmentId,
        createdAt: row.createdAt,
        ...staffContributionView(row, canSeePricing),
      }));
    }
    if (actor.kind !== 'provider')
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );
    const own = await this.prisma.assignment.findMany({
      where: { requestId: request.id, providerUserId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    if (own.length === 0) throw notFound();
    const current = own.find((item) => item.status === 'accepted');
    const rows = current
      ? await this.prisma.contribution.findMany({
          where: { requestId: request.id, assignmentId: current.id },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    return rows.map((row) => ({
      id: row.id,
      assignmentId: row.assignmentId,
      createdAt: row.createdAt,
      total: Number(row.total),
      ...providerContributionView(row),
    }));
  }

  async contribute(
    user: RequestUser,
    ref: string,
    dto: { items: Line[]; note?: string },
    version: number | undefined,
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
        // The runner guard covers 04 §6.10 preconditions; the row supplies the assignment id.
        if (!assignment)
          throw conflict(
            'Accept the current assignment before updating this job.',
          );
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

  /** Role-scoped quote DTOs (04 §4.6, §10); rows are never returned as stored. */
  async listQuotes(user: RequestUser, ref: string) {
    const actor = await this.actors.resolve(user.id);
    const request = await this.findRequest(ref);
    const permissions = actor.staff?.permissions;
    if (
      actor.kind === 'staff' &&
      actor.staff?.status === 'active' &&
      QUOTE_READERS.some((permission) => permissions?.has(permission))
    ) {
      const canSeePricing = permissions?.has('view.pricing') ?? false;
      const rows = await this.prisma.quote.findMany({
        where: { requestId: request.id },
        orderBy: { version: 'desc' },
      });
      const suggestion = canSeePricing
        ? await this.payoutSuggestionFor(request.id)
        : null;
      return rows.map((row) =>
        staffQuoteView(row, {
          canSeePricing,
          userId: user.id,
          canApprove: permissions?.has('quote.approve') ?? false,
          isSuperAdmin: actor.staff?.isSuperAdmin ?? false,
          payoutSuggestion: suggestion,
        }),
      );
    }
    if (user.id === request.ownerId) {
      const rows = await this.prisma.quote.findMany({
        where: { requestId: request.id, status: { not: 'draft' } },
        orderBy: { version: 'desc' },
      });
      return rows.map(customerQuoteView);
    }
    if (actor.platformRoles.includes('provider')) {
      const held = confirmedAssignmentIds(
        await this.prisma.assignment.findMany({
          where: { requestId: request.id, providerUserId: user.id },
          select: {
            id: true,
            providerUserId: true,
            status: true,
            reviewedAt: true,
          },
        }),
        user.id,
      );
      if (held.length === 0) throw notFound();
      const rows = await this.prisma.quote.findMany({
        where: { requestId: request.id, status: { in: ['sent', 'accepted'] } },
        orderBy: { version: 'desc' },
      });
      return rows.map((row) => providerQuoteView(row, held));
    }
    if (actor.kind === 'staff') requirePermission(actor, 'quote.manage');
    throw notFound();
  }

  async saveQuote(
    userId: string,
    ref: string,
    dto: { quoteId?: string; revision?: number; items: Line[]; note?: string },
    version: number | undefined,
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
        // The runner guard covers the paid and status rows of 04 §6.11; the edit rows below need the quote row.
        const assignment = await this.acceptedAssignment(
          ctx.tx,
          ctx.snap.id,
          'Confirm a provider assignment before preparing a quote.',
        );
        const total = sumItems(dto.items);
        let row;
        let clearedApproval = false;
        if (dto.quoteId) {
          row = await ctx.tx.quote.findFirst({
            where: { id: dto.quoteId, requestId: ctx.snap.id },
          });
          if (!row) throw conflict(QUOTE_GONE);
          if (row.status !== 'draft')
            throw conflict(
              'Published quote versions cannot be edited. Create a new version.',
            );
          if (row.revision !== dto.revision)
            throw conflict(
              'This quote changed since you opened it. Reload and review the latest version.',
            );
          clearedApproval = row.approvalRequestedAt !== null;
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
              customerNote: null,
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
        if (clearedApproval)
          ctx.audit('Quote approval request cleared after edit', {
            resourceType: 'quote',
            resourceId: row.id,
            changes: { version: row.version, revision: row.revision },
          });
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
    version: number | undefined,
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
    version: number | undefined,
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
        const selfApproved = quote.lastEditedBy === userId;
        // Rows 3 and 4 of the 04 §6.11 sign-off table need the count of active super admins, which the snapshot lacks.
        const failure = selfApprovalFailure({
          lastEditedBy: quote.lastEditedBy,
          actorId: userId,
          isSuperAdmin: ctx.actor.staff?.isSuperAdmin ?? false,
          activeSuperAdminIds: selfApproved
            ? await this.activeSuperAdminIds(ctx.tx)
            : [],
          reason: dto.selfApprovalReason,
        });
        if (!failure.ok)
          throw new AppError(failure.status, failure.code, failure.message);
        await this.publishWithin(
          ctx,
          quoteId,
          {
            revision: dto.revision,
            pricingOverrideNote: quote.pricingOverrideNote ?? undefined,
            customerNote: quote.customerNote ?? undefined,
          },
          userId,
          true,
        );
        await ctx.tx.quote.update({
          where: { id: quoteId },
          data: { approvedBy: userId, selfApproved },
        });
        ctx.audit('Quote approved', {
          resourceType: 'quote',
          resourceId: quoteId,
          note: selfApproved ? dto.selfApprovalReason?.trim() : undefined,
          changes: { version: quote.version, selfApproved },
          ...(selfApproved ? { flags: ['self_approved'] } : {}),
        });
      },
    );
  }

  async returnQuote(
    userId: string,
    ref: string,
    quoteId: string,
    dto: { revision: number; note: string },
    version: number | undefined,
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
            customerNote: null,
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
    version: number | undefined,
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
        // The guard checked the latest sent quote; this ties the route's quote id to it.
        if (
          !quote ||
          quote.status !== 'sent' ||
          ctx.snap.latestSentQuote?.version !== quote.version
        )
          throw conflict(
            'This quote has already changed or received a response.',
          );
        const note = dto.note?.trim() || null;
        const stopValidityTimers = () =>
          ctx.timers.stop(
            ['T8.reminder3d', 'T8.reminder1d', 'T8.expire'],
            quote.id,
          );
        if (dto.decision === 'accepted') {
          const dueDays = Number(ctx.settings['payment.dueDays'] ?? 7);
          const dueAt = new Date(ctx.now.getTime() + dueDays * DAY_MS);
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'accepted',
              respondedAt: ctx.now,
              acceptedAt: ctx.now,
              paymentDueAt: dueAt,
              responseNote: note,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'awaiting_payment' },
          });
          stopValidityTimers();
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
            changes: { version: quote.version },
          });
          const accepted = {
            requestCode: ctx.snap.number,
            amount: Number(quote.total),
            dueDate: dueAt.toLocaleDateString('en-NG', {
              timeZone: 'Africa/Lagos',
            }),
          };
          ctx.notify('quote.payment_due', accepted);
          ctx.notify('quote.accepted', accepted);
          ctx.notify('quote.accepted_provider', {
            requestCode: ctx.snap.number,
          });
        } else if (dto.decision === 'revision_requested') {
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'revision_requested',
              respondedAt: ctx.now,
              responseNote: note,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'matched' },
          });
          stopValidityTimers();
          ctx.audit('Quote revision requested', {
            resourceType: 'quote',
            resourceId: quote.id,
            note: dto.note,
          });
          ctx.notify('quote.revision_requested', {
            requestCode: ctx.snap.number,
            note: dto.note,
          });
          ctx.notify('quote.changes_requested_provider', {
            requestCode: ctx.snap.number,
          });
        } else if (dto.decision === 'declined') {
          await ctx.tx.quote.update({
            where: { id: quote.id },
            data: {
              status: 'declined',
              respondedAt: ctx.now,
              responseNote: note,
            },
          });
          await ctx.tx.serviceRequest.update({
            where: { id: ctx.snap.id },
            data: { status: 'matched' },
          });
          // The guard refused a second pending cancellation (04 §6.21: one at a time).
          const cancellation = await ctx.tx.cancellation.create({
            data: {
              requestId: ctx.snap.id,
              requestedBy: 'customer',
              requestedById: user.id,
              reasonCode: 'quote_declined',
              note: note ?? '',
              stage: ctx.snap.status,
              paid: ctx.snap.payment.paid,
            },
          });
          stopValidityTimers();
          ctx.timers.start(
            TimerKinds.T19Followup,
            new Date(ctx.now.getTime() + 48 * 60 * 60_000),
            cancellation.id,
          );
          ctx.audit('Quote declined', {
            resourceType: 'quote',
            resourceId: quote.id,
            note: dto.note,
          });
          ctx.audit('Cancellation requested', {
            resourceType: 'cancellation',
            resourceId: cancellation.id,
            note: dto.note,
            changes: { reasonCode: 'quote_declined', quoteId: quote.id },
          });
          ctx.notify('quote.declined', { requestCode: ctx.snap.number });
        } else {
          throw fail('Choose accept, decline or request a revision.');
        }
      },
    );
  }

  async setPayout(
    userId: string,
    ref: string,
    quoteId: string,
    amount: number,
    version: number | undefined,
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
            status: { in: ['sent', 'accepted'] },
          },
        });
        if (!quote) throw conflict(QUOTE_GONE);
        // The runner guard checked the amount is a positive integer; the quote total needs the row.
        if (BigInt(amount) > quote.total)
          throw fail(
            'Enter a payout amount above 0 and no higher than the quote total.',
          );
        const assignment = await this.acceptedAssignment(
          ctx.tx,
          ctx.snap.id,
          'Confirm a provider assignment before setting the payout.',
        );
        await ctx.tx.quote.update({
          where: { id: quote.id },
          data: {
            payoutAmount: BigInt(amount),
            payoutAssignmentId: assignment.id,
          },
        });
        ctx.audit('Provider payout amount changed', {
          resourceType: 'quote',
          resourceId: quote.id,
          changes: {
            before: {
              payoutAmount:
                quote.payoutAmount == null ? null : Number(quote.payoutAmount),
              payoutAssignmentId: quote.payoutAssignmentId,
            },
            after: { payoutAmount: amount, payoutAssignmentId: assignment.id },
          },
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
    const assignment = await this.acceptedAssignment(
      ctx.tx,
      ctx.snap.id,
      'Confirm a provider assignment before publishing the quote.',
    );
    // A note given now wins; otherwise the one stored when the draft was held stays (B-15).
    const overrideNote =
      dto.pricingOverrideNote?.trim() || quote.pricingOverrideNote || null;
    // The publish guard checked the body's notes; an approval has no body, so the held notes are checked here.
    if (approved) {
      const contribution = await ctx.tx.contribution.findFirst({
        where: { requestId: ctx.snap.id, assignmentId: assignment.id },
      });
      if (!contribution && !overrideNote)
        throw conflict(
          "Get the provider's costing first, or add a pricing override note.",
        );
    }
    if (
      quote.basedOnAssignmentId &&
      quote.basedOnAssignmentId !== assignment.id &&
      !overrideNote
    )
      throw conflict(
        'This draft was prepared for the previous provider. Add a note to publish it anyway.',
      );
    if (
      approved &&
      ctx.snap.status === 'awaiting_payment' &&
      !dto.customerNote?.trim()
    )
      throw fail('Add a note for the customer explaining the new version.');
    if (
      !approved &&
      requiresSignOff({
        threshold: ctx.settings['quote.approvalThreshold'],
        total: quote.total,
        holdsApprove:
          ctx.actor.staff?.permissions.has('quote.approve') ?? false,
        lastEditedBy: quote.lastEditedBy,
        actorId: userId,
      })
    ) {
      await ctx.tx.quote.update({
        where: { id: quote.id },
        data: {
          approvalRequestedBy: userId,
          approvalRequestedAt: ctx.now,
          pricingOverrideNote: overrideNote,
          customerNote: dto.customerNote?.trim() || null,
        },
      });
      ctx.audit('Quote approval requested', {
        resourceType: 'quote',
        resourceId: quote.id,
        changes: { version: quote.version },
      });
      ctx.notify('quote.approval_needed', { requestCode: ctx.snap.number });
      return { status: 202 };
    }
    const validDays = Number(ctx.settings['quote.validityDays'] ?? 14);
    const validUntil = new Date(ctx.now.getTime() + validDays * DAY_MS);
    await ctx.tx.quote.update({
      where: { id: quote.id },
      data: {
        status: 'sent',
        publishedBy: userId,
        publishedAt: ctx.now,
        validUntil,
        pricingOverrideNote: overrideNote,
        approvalRequestedBy: null,
        approvalRequestedAt: null,
        customerNote: null,
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
      new Date(validUntil.getTime() - 3 * DAY_MS),
      quote.id,
    );
    ctx.timers.start(
      'T8.reminder1d',
      new Date(validUntil.getTime() - DAY_MS),
      quote.id,
    );
    ctx.timers.start('T8.expire', validUntil, quote.id);
    ctx.notify('quote.ready', {
      requestCode: ctx.snap.number,
      note: dto.customerNote,
    });
    // An approval writes its own `Quote approved` audit.
    if (!approved)
      ctx.audit('Quote published', {
        resourceType: 'quote',
        resourceId: quote.id,
        changes: { version: quote.version },
      });
  }

  private async acceptedAssignment(
    tx: Prisma.TransactionClient,
    requestId: string,
    message: string,
  ) {
    const assignment = await tx.assignment.findFirst({
      where: { requestId, status: 'accepted' },
      orderBy: { createdAt: 'desc' },
    });
    // The runner guard checked this against the snapshot; the row supplies the assignment id.
    if (!assignment) throw conflict(message);
    return assignment;
  }

  private async activeSuperAdminIds(
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.staffMember.findMany({
      where: {
        status: 'active',
        roles: { some: { role: 'super_admin' } },
        user: { status: 'active' },
      },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  private async payoutSuggestionFor(requestId: string): Promise<number | null> {
    const current = await this.prisma.assignment.findFirst({
      where: { requestId, status: 'accepted' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!current) return null;
    const contributions = await this.prisma.contribution.findMany({
      where: { requestId, assignmentId: current.id },
      orderBy: { createdAt: 'desc' },
      select: { assignmentId: true, total: true },
    });
    return payoutSuggestion(contributions, current.id);
  }

  private async findRequest(ref: string) {
    const id = await resolveRequestId(this.prisma, ref);
    const row = id
      ? await this.prisma.serviceRequest.findUnique({ where: { id } })
      : null;
    if (!row) throw notFound();
    return row;
  }

  private run(
    actor: Awaited<ReturnType<ActorService['resolve']>>,
    command: string,
    ref: string,
    version: number | undefined,
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
