import { Inject, Injectable } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { decryptSecret, encryptSecret } from '../common/utils/crypto.util';
import { PAYMENT_GATEWAY } from './payments.service';
import type { PaymentGateway } from './payment-gateway';

const denied = () =>
  new AppError(403, 'FORBIDDEN', 'Your staff role does not allow this action.');
const conflict = (message: string) =>
  new AppError(409, 'STATE_CONFLICT', message);
const invalid = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);
const payoutView = <T extends { amount: bigint }>(row: T) => ({
  ...row,
  amount: Number(row.amount),
});

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly uploads: UploadsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async createPrimary(
    tx: import('@prisma/client').Prisma.TransactionClient,
    input: {
      requestId: string;
      assignmentId: string;
      providerId: string;
      amount: bigint;
      now: Date;
    },
  ) {
    const existing = await tx.payout.findFirst({
      where: {
        requestId: input.requestId,
        assignmentId: input.assignmentId,
        kind: 'primary',
      },
    });
    if (existing) return existing;
    const bank = await tx.providerBankAccount.findFirst({
      where: { providerId: input.providerId, state: 'verified' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    return tx.payout.create({
      data: {
        requestId: input.requestId,
        assignmentId: input.assignmentId,
        providerId: input.providerId,
        amount: input.amount,
        status: 'pending_approval',
        bankAccountId: bank?.id ?? null,
        createdAt: input.now,
      },
    });
  }

  async payouts(userId: string, page = 1) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const limit = 25;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payout.count(),
    ]);
    const providers = await this.prisma.providerProfile.findMany({
      where: { id: { in: items.map((item) => item.providerId) } },
      select: { id: true, userId: true, businessName: true },
    });
    const providerById = new Map(
      providers.map((provider) => [provider.id, provider]),
    );
    return {
      items: items.map((row) => ({
        ...row,
        amount: Number(row.amount),
        providerName: providerById.get(row.providerId)?.businessName ?? null,
        providerUserId: providerById.get(row.providerId)?.userId ?? null,
        maskedBankAccount: row.bankLast4 ? `•••• ${row.bankLast4}` : null,
        method: row.transferRecordedBy ? 'offline' : 'paystack',
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    };
  }

  async approvePayout(userId: string, id: string, note?: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const payout = await this.prisma.payout.findUnique({
      where: { id },
    });
    if (!payout || payout.status !== 'pending_approval')
      throw conflict('This payout is not awaiting approval.');
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: payout.providerId },
      select: { user: { select: { status: true } } },
    });
    if (provider?.user.status !== 'active')
      throw conflict(
        'Provider must be active before this payout can be approved.',
      );
    const [request, openIssues] = await Promise.all([
      this.prisma.serviceRequest.findUnique({
        where: { id: payout.requestId },
        select: { holdKind: true },
      }),
      this.prisma.issue.count({
        where: { requestId: payout.requestId, status: 'open' },
      }),
    ]);
    if (request?.holdKind || openIssues)
      throw conflict(
        'Resolve the request hold or open issue before approving this payout.',
      );
    const bank = payout.bankAccountId
      ? await this.prisma.providerBankAccount.findUnique({
          where: { id: payout.bankAccountId },
        })
      : null;
    if (!bank || bank.state !== 'verified')
      throw conflict('The provider has no verified bank account.');
    const thresholdSetting = await this.prisma.setting.findUnique({
      where: { key: 'payout.secondApprovalThreshold' },
      select: { value: true },
    });
    const threshold =
      typeof thresholdSetting?.value === 'number'
        ? thresholdSetting.value
        : Number.MAX_SAFE_INTEGER;
    const second = payout.amount >= BigInt(threshold);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.payoutApproval.create({
        data: {
          payoutId: id,
          step: 1,
          actorId: userId,
          note: note?.trim() || null,
          bankVersion: bank.updatedAt.toISOString(),
        },
      });
      return tx.payout.update({
        where: { id },
        data: {
          status: second ? 'awaiting_second_approval' : 'approved',
          bankLast4: bank.last4,
        },
      });
    });
    return payoutView(updated);
  }

  async secondApprovePayout(
    userId: string,
    id: string,
    approve: boolean,
    note: string,
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const row = await this.prisma.payout.findUnique({
      where: { id },
      include: { approvals: true },
    });
    if (!row || row.status !== 'awaiting_second_approval')
      throw conflict('This payout is not awaiting a second approval.');
    if (
      !actor.staff?.isSuperAdmin ||
      row.approvals.some((approval) => approval.actorId === userId)
    )
      throw denied();
    if (!note.trim()) throw invalid('Add a note for the second approval.');
    return this.prisma.$transaction(async (tx) => {
      await tx.payoutApproval.create({
        data: { payoutId: id, step: 2, actorId: userId, note: note.trim() },
      });
      return payoutView(
        await tx.payout.update({
          where: { id },
          data: { status: approve ? 'approved' : 'cancelled' },
        }),
      );
    });
  }

  async payoutHold(userId: string, id: string, hold: boolean, reason: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const row = await this.prisma.payout.findUnique({ where: { id } });
    if (!row || !reason.trim())
      throw invalid('Add a reason for this payout action.');
    if (
      hold &&
      !['pending_approval', 'awaiting_second_approval', 'approved'].includes(
        row.status,
      )
    )
      throw conflict('This payout can no longer be held.');
    if (!hold && row.status !== 'on_hold')
      throw conflict('This payout is not on hold.');
    if (!hold) {
      const issues = await this.prisma.issue.count({
        where: { requestId: row.requestId, status: 'open' },
      });
      const request = await this.prisma.serviceRequest.findUnique({
        where: { id: row.requestId },
        select: { holdKind: true },
      });
      const profile = await this.prisma.providerProfile.findUnique({
        where: { id: row.providerId },
        include: { user: { select: { status: true } } },
      });
      if (issues || request?.holdKind || profile?.user.status !== 'active')
        throw conflict(
          'Resolve the request hold, open issue or provider suspension before releasing this payout.',
        );
    }
    return payoutView(
      await this.prisma.payout.update({
        where: { id },
        data: hold
          ? { status: 'on_hold', holdReason: reason.trim(), holdSource: userId }
          : { status: 'pending_approval', holdReason: null, holdSource: null },
      }),
    );
  }

  async transferPayout(
    userId: string,
    id: string,
    dto:
      | { method: 'paystack' }
      | { method: 'offline'; reference: string; proofFileId: string },
  ) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const row = await this.prisma.payout.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'approved')
      throw conflict('This payout is not approved for transfer.');
    if (dto.method === 'offline') {
      return this.prisma.$transaction(async (tx) => {
        await this.uploads.attach(
          tx,
          [dto.proofFileId],
          userId,
          'payment_proof',
          'payout',
          id,
        );
        return tx.payout.update({
          where: { id },
          data: {
            status: 'processing',
            transferReference: dto.reference,
            transferProofId: dto.proofFileId,
            transferRecordedBy: userId,
          },
        });
      });
    }
    const bank = row.bankAccountId
      ? await this.prisma.providerBankAccount.findUnique({
          where: { id: row.bankAccountId },
        })
      : null;
    if (!bank || bank.state !== 'verified')
      throw conflict('The provider has no verified bank account.');
    const latestApproval = await this.prisma.payoutApproval.findFirst({
      where: { payoutId: id, step: { in: [1, 2] } },
      orderBy: { step: 'desc' },
    });
    if (
      latestApproval?.bankVersion &&
      latestApproval.bankVersion !== bank.updatedAt.toISOString()
    )
      throw conflict(
        'The provider bank details changed after approval. Review the bank account and approve again.',
      );
    let recipientCode = bank.recipientCodeEnc
      ? decryptSecret(bank.recipientCodeEnc)
      : '';
    if (!recipientCode) {
      const recipient = await this.gateway.createRecipient({
        name: decryptSecret(bank.accountNameEnc),
        accountNumber: decryptSecret(bank.accountNumberEnc),
        bankCode: bank.bankCode,
      });
      recipientCode = recipient.recipientCode;
      await this.prisma.providerBankAccount.update({
        where: { id: bank.id },
        data: { recipientCodeEnc: encryptSecret(recipientCode) },
      });
    }
    const reference = `xpro_transfer_${id}_${Date.now()}`;
    const attempt = await this.prisma.transferAttempt.create({
      data: {
        payoutId: id,
        reference,
        amount: row.amount,
        status: 'pending',
        submittedAt: new Date(),
      },
    });
    try {
      const result = await this.gateway.transfer({
        amount: Number(row.amount),
        recipientCode,
        reference,
        reason: `XPro provider payout ${id}`,
      });
      await this.prisma.$transaction([
        this.prisma.transferAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'processing',
            gatewayTransferId: result.transferId ?? null,
          },
        }),
        this.prisma.payout.update({
          where: { id },
          data: { status: 'processing', transferReference: reference },
        }),
      ]);
      return payoutView(
        await this.prisma.payout.findUniqueOrThrow({ where: { id } }),
      );
    } catch (error) {
      await this.prisma.transferAttempt.update({
        where: { id: attempt.id },
        data: { status: 'failed', failureCode: 'gateway_error' },
      });
      throw error;
    }
  }

  async reconcilePayout(userId: string, id: string, note: string) {
    const actor = await this.actors.resolve(userId);
    requirePermission(actor, 'payout.approve');
    const row = await this.prisma.payout.findUnique({ where: { id } });
    if (!row || row.status !== 'processing' || !row.transferRecordedBy)
      throw conflict('This offline payout is not awaiting reconciliation.');
    if (row.transferRecordedBy === userId)
      throw conflict('Another Finance user must reconcile this transfer.');
    if (!note.trim()) throw invalid('Add a reconciliation note.');
    return payoutView(
      await this.prisma.payout.update({
        where: { id },
        data: { status: 'paid', paidAt: new Date(), reconciledBy: userId },
      }),
    );
  }

  async earnings(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (!profile)
      throw new AppError(
        404,
        'NOT_FOUND',
        'Provider payout history is unavailable.',
      );
    const payouts = await this.prisma.payout.findMany({
      where: { providerId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      payouts: payouts.map((payout) => ({
        id: payout.id,
        amount: Number(payout.amount),
        status: payout.status,
        requestId: payout.requestId,
        method: payout.transferRecordedBy ? 'offline' : 'paystack',
      })),
      totalPaid: payouts
        .filter((row) => row.status === 'paid')
        .reduce((sum, row) => sum + Number(row.amount), 0),
      totalPending: payouts
        .filter((row) => !['paid', 'cancelled'].includes(row.status))
        .reduce((sum, row) => sum + Number(row.amount), 0),
    };
  }

  async closureState(requestId: string): Promise<{
    state: 'paid' | 'on_hold_with_reason' | 'blocked';
    reason?: string;
  }> {
    const payouts = await this.prisma.payout.findMany({
      where: { requestId },
      orderBy: { createdAt: 'desc' },
    });
    if (!payouts.length)
      return {
        state: 'blocked',
        reason: 'No provider payout has been created.',
      };
    const hold = payouts.find((payout) => payout.status === 'on_hold');
    if (hold)
      return {
        state: 'on_hold_with_reason',
        reason: hold.holdReason ?? 'Provider payout is on hold.',
      };
    if (
      payouts.some((payout) => !['paid', 'cancelled'].includes(payout.status))
    )
      return {
        state: 'blocked',
        reason: 'A provider payout is still pending.',
      };
    return { state: 'paid' };
  }
}
