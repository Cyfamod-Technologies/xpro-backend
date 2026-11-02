import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The gateway answered and refused the request, so nothing was created on its
 * side. Any other error (a timeout, a dropped connection, a 5xx) leaves the
 * outcome unknown and must be verified before a retry (05 §8, plan C.4).
 */
export class GatewayRejectedError extends ServiceUnavailableException {}

/** The gateway answered 404: it holds nothing under that reference. Unlike a timeout, this is a definite answer. */
export class GatewayNotFoundError extends GatewayRejectedError {}

export type GatewayRefund = { id: string; status: string; amount?: number };

export type VerifiedTransaction = {
  status: string;
  reference: string;
  amount: number;
  /** Paystack fee charged for the collection, in kobo. */
  fees?: number;
  currency: string;
  channel?: string;
  paidAt?: string;
  customer?: { email?: string };
  metadata?: unknown;
  id?: number | string;
};

export interface PaymentGateway {
  initialize(input: {
    email: string;
    amount: number;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<VerifiedTransaction>;
  verifyRefund(id: string): Promise<GatewayRefund>;
  /** Every refund the gateway holds for a transaction reference, to find one whose submission outcome was not recorded. */
  listRefunds(transactionReference: string): Promise<GatewayRefund[]>;
  /** `null` when Paystack does not know the reference; a timeout or 5xx throws, because then the outcome is unknown. */
  verifyTransfer(reference: string): Promise<{
    reference: string;
    status: string;
    id?: string;
    amount?: number;
    /** Paystack transfer fee charged, in kobo. */
    feeCharged?: number;
  } | null>;
  refund(input: {
    reference: string;
    amount: number;
    reason: string;
  }): Promise<{ id: string; status: string }>;
  createRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }): Promise<{ recipientCode: string }>;
  /** Resolves with Paystack's synchronous status (`pending`, `success`, `failed` or `otp`). Only a verified event marks a payout paid. */
  transfer(input: {
    amount: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }): Promise<{ transferId?: string; status: string }>;
}
