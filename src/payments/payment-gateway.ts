import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The gateway answered and refused the request, so nothing was created on its
 * side. Any other error (a timeout, a dropped connection, a 5xx) leaves the
 * outcome unknown and must be verified before a retry (05 §8, plan C.4).
 */
export class GatewayRejectedError extends ServiceUnavailableException {}

export type GatewayRefund = { id: string; status: string; amount?: number };

export type VerifiedTransaction = {
  status: string;
  reference: string;
  amount: number;
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
  verifyTransfer(
    reference: string,
  ): Promise<{ reference: string; status: string; id?: string }>;
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
  transfer(input: {
    amount: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }): Promise<{ transferId?: string }>;
}
