import { Injectable } from '@nestjs/common';
import type { PaymentGateway, VerifiedTransaction } from './payment-gateway';

@Injectable()
export class TestPaymentGateway implements PaymentGateway {
  private readonly transactions = new Map<string, VerifiedTransaction>();
  async initialize(input: { email: string; amount: number; reference: string; metadata: Record<string, string> }) {
    this.transactions.set(input.reference, { status: 'success', reference: input.reference, amount: input.amount, currency: 'NGN', customer: { email: input.email }, metadata: input.metadata });
    return { authorizationUrl: `https://checkout.test.invalid/${encodeURIComponent(input.reference)}` };
  }
  async verify(reference: string) {
    return this.transactions.get(reference) ?? { status: 'pending', reference, amount: 0, currency: 'NGN' };
  }
  async verifyRefund(id: string) { return { id, status: 'processed' }; }
  async verifyTransfer(reference: string) { return { reference, status: 'success', id: `test-transfer-${reference}` }; }
  async refund(input: { reference: string; amount: number; reason: string }) { return { id: `test-refund-${input.reference}`, status: 'processing' }; }
  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) { return { recipientCode: `RCP_TEST_${input.bankCode}_${input.accountNumber.slice(-4)}` }; }
  async transfer(input: { amount: number; recipientCode: string; reference: string; reason: string }) { return { transferId: `test-transfer-${input.reference}` }; }
}
