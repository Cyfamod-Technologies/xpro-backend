import { Injectable } from '@nestjs/common';
import {
  FinancialLedgerAccountType,
  FinancialLedgerSide,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const FINANCIAL_LEDGER_ACCOUNTS = {
  paystackClearing: {
    code: 'paystack_clearing',
    name: 'Paystack clearing',
    type: FinancialLedgerAccountType.asset,
    normalSide: FinancialLedgerSide.debit,
  },
  platformBank: {
    code: 'platform_bank',
    name: 'XPro operating bank',
    type: FinancialLedgerAccountType.asset,
    normalSide: FinancialLedgerSide.debit,
  },
  refundReserveBank: {
    code: 'refund_reserve_bank',
    name: 'XPro refund reserve bank',
    type: FinancialLedgerAccountType.asset,
    normalSide: FinancialLedgerSide.debit,
  },
  customerFundsHeld: {
    code: 'customer_funds_held',
    name: 'Customer funds held',
    type: FinancialLedgerAccountType.liability,
    normalSide: FinancialLedgerSide.credit,
  },
  providerPayoutsPayable: {
    code: 'provider_payouts_payable',
    name: 'Provider payouts payable',
    type: FinancialLedgerAccountType.liability,
    normalSide: FinancialLedgerSide.credit,
  },
  refundsPayable: {
    code: 'refunds_payable',
    name: 'Customer refunds payable',
    type: FinancialLedgerAccountType.liability,
    normalSide: FinancialLedgerSide.credit,
  },
  platformRevenue: {
    code: 'platform_revenue',
    name: 'XPro platform revenue',
    type: FinancialLedgerAccountType.revenue,
    normalSide: FinancialLedgerSide.credit,
  },
  refundExpense: {
    code: 'refund_expense',
    name: 'Refunds funded by XPro',
    type: FinancialLedgerAccountType.expense,
    normalSide: FinancialLedgerSide.debit,
  },
  paymentGatewayFees: {
    code: 'payment_gateway_fees',
    name: 'Payment gateway fees',
    type: FinancialLedgerAccountType.expense,
    normalSide: FinancialLedgerSide.debit,
  },
} as const;

export type LedgerAccountCode =
  (typeof FINANCIAL_LEDGER_ACCOUNTS)[keyof typeof FINANCIAL_LEDGER_ACCOUNTS]['code'];

export type LedgerLine = {
  account: (typeof FINANCIAL_LEDGER_ACCOUNTS)[keyof typeof FINANCIAL_LEDGER_ACCOUNTS];
  side: FinancialLedgerSide;
  amount: bigint;
  requestId?: string;
};

export type LedgerJournalInput = {
  sourceType: string;
  sourceId: string;
  event: string;
  idempotencyKey: string;
  description: string;
  currency?: string;
  createdBy?: string;
  metadata?: Prisma.InputJsonValue;
  lines: LedgerLine[];
};

const invalidJournal = (message: string): never => {
  throw new Error(`Invalid financial ledger journal: ${message}`);
};

@Injectable()
export class FinancialLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes a balanced, idempotent journal in the caller's transaction. Ledger
   * entries are only created here and are never updated or deleted.
   */
  async post(
    tx: Prisma.TransactionClient,
    input: LedgerJournalInput,
  ): Promise<{ id: string; created: boolean }> {
    const currency = (input.currency ?? 'NGN').toUpperCase();
    if (!input.lines.length)
      invalidJournal('at least two entries are required');
    if (!/^[A-Z]{3}$/.test(currency))
      invalidJournal('currency must be ISO-4217');
    if (!input.idempotencyKey.trim())
      invalidJournal('idempotency key is required');

    let debits = 0n;
    let credits = 0n;
    for (const line of input.lines) {
      if (line.amount <= 0n) invalidJournal('entry amounts must be positive');
      if (line.side === FinancialLedgerSide.debit) debits += line.amount;
      else credits += line.amount;
    }
    if (debits !== credits) invalidJournal('debits and credits must balance');

    const existing = await tx.financialLedgerJournal.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    const accounts = [
      ...new Map(
        input.lines.map((line) => [line.account.code, line.account]),
      ).values(),
    ];
    for (const account of accounts) {
      await tx.financialLedgerAccount.upsert({
        where: { code: account.code },
        create: { ...account, currency },
        update: {},
      });
    }

    try {
      const journal = await tx.financialLedgerJournal.create({
        data: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          event: input.event,
          idempotencyKey: input.idempotencyKey,
          description: input.description,
          currency,
          createdBy: input.createdBy,
          metadata: input.metadata,
          entries: {
            create: input.lines.map((line) => ({
              accountCode: line.account.code,
              side: line.side,
              amount: line.amount,
              currency,
              requestId: line.requestId,
            })),
          },
        },
        select: { id: true },
      });
      return { id: journal.id, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicate = await tx.financialLedgerJournal.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (duplicate) return { id: duplicate.id, created: false };
      }
      throw error;
    }
  }

  /** Returns debit-normalized balances for internal reconciliation and future finance summaries. */
  async balances(currency = 'NGN') {
    const normalizedCurrency = currency.toUpperCase();
    const accounts = await this.prisma.financialLedgerAccount.findMany({
      where: { currency: normalizedCurrency, active: true },
      orderBy: { code: 'asc' },
    });
    const totals = await this.prisma.financialLedgerEntry.groupBy({
      by: ['accountCode', 'side'],
      where: { currency: normalizedCurrency },
      _sum: { amount: true },
    });
    const amounts = new Map(
      totals.map((row) => [
        `${row.accountCode}:${row.side}`,
        row._sum.amount ?? 0n,
      ]),
    );
    return accounts.map((account) => {
      const debits = amounts.get(`${account.code}:debit`) ?? 0n;
      const credits = amounts.get(`${account.code}:credit`) ?? 0n;
      const balance =
        account.normalSide === FinancialLedgerSide.debit
          ? debits - credits
          : credits - debits;
      return {
        code: account.code,
        name: account.name,
        type: account.type,
        currency: account.currency,
        debitTotal: debits.toString(),
        creditTotal: credits.toString(),
        balance: balance.toString(),
      };
    });
  }

  /** Returns the signed normal balance of one account for one request. */
  async balanceForRequest(
    tx: Prisma.TransactionClient,
    accountCode: LedgerAccountCode,
    requestId: string,
    currency = 'NGN',
  ): Promise<bigint> {
    const [account, totals] = await Promise.all([
      tx.financialLedgerAccount.findUnique({ where: { code: accountCode } }),
      tx.financialLedgerEntry.groupBy({
        by: ['side'],
        where: { accountCode, requestId, currency: currency.toUpperCase() },
        _sum: { amount: true },
      }),
    ]);
    const debits =
      totals.find((row) => row.side === FinancialLedgerSide.debit)?._sum
        .amount ?? 0n;
    const credits =
      totals.find((row) => row.side === FinancialLedgerSide.credit)?._sum
        .amount ?? 0n;
    const normalSide =
      account?.normalSide ??
      FINANCIAL_LEDGER_ACCOUNTS.customerFundsHeld.normalSide;
    return normalSide === FinancialLedgerSide.debit
      ? debits - credits
      : credits - debits;
  }

  /** Returns the signed normal balance of one company account. */
  async balanceForAccount(
    tx: Prisma.TransactionClient,
    accountCode: LedgerAccountCode,
    currency = 'NGN',
  ): Promise<bigint> {
    const definition = Object.values(FINANCIAL_LEDGER_ACCOUNTS).find(
      (account) => account.code === accountCode,
    );
    if (!definition)
      throw new Error(`Unknown financial ledger account ${accountCode}`);
    const totals = await tx.financialLedgerEntry.groupBy({
      by: ['side'],
      where: { accountCode, currency: currency.toUpperCase() },
      _sum: { amount: true },
    });
    const debits =
      totals.find((row) => row.side === FinancialLedgerSide.debit)?._sum
        .amount ?? 0n;
    const credits =
      totals.find((row) => row.side === FinancialLedgerSide.credit)?._sum
        .amount ?? 0n;
    return definition.normalSide === FinancialLedgerSide.debit
      ? debits - credits
      : credits - debits;
  }
}
