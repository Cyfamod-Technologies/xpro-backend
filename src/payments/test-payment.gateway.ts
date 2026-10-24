import { Injectable } from '@nestjs/common';
import type { PaymentGateway, VerifiedTransaction } from './payment-gateway';

@Injectable()
export class TestPaymentGateway implements PaymentGateway {
  private readonly transactions = new Map<string, VerifiedTransaction>();
  initialize(input: {
    email: string;
    amount: number;
    reference: string;
    metadata: Record<string, string>;
  }) {
    this.transactions.set(input.reference, {
      status: 'success',
      reference: input.reference,
      amount: input.amount,
      currency: 'NGN',
      customer: { email: input.email },
      metadata: input.metadata,
    });
    return Promise.resolve({
      authorizationUrl: `https://checkout.test.invalid/${encodeURIComponent(input.reference)}`,
    });
  }
  verify(reference: string) {
    return Promise.resolve(
      this.transactions.get(reference) ?? {
        status: 'pending',
        reference,
        amount: 0,
        currency: 'NGN',
      },
    );
  }
  verifyRefund(id: string) {
    return Promise.resolve({ id, status: 'processed' });
  }
  verifyTransfer(reference: string) {
    return Promise.resolve({
      reference,
      status: 'success',
      id: `test-transfer-${reference}`,
    });
  }
  refund(input: { reference: string; amount: number; reason: string }) {
    return Promise.resolve({
      id: `test-refund-${input.reference}`,
      status: 'processing',
    });
  }
  createRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }) {
    return Promise.resolve({
      recipientCode: `RCP_TEST_${input.bankCode}_${input.accountNumber.slice(-4)}`,
    });
  }
  transfer(input: {
    amount: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }) {
    return Promise.resolve({ transferId: `test-transfer-${input.reference}` });
  }
}
