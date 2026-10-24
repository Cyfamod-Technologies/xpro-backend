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
  initialize(input: { email: string; amount: number; reference: string; metadata: Record<string, string> }): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<VerifiedTransaction>;
  verifyRefund(id: string): Promise<{ id: string; status: string; amount?: number }>;
  verifyTransfer(reference: string): Promise<{ reference: string; status: string; id?: string }>;
  refund(input: { reference: string; amount: number; reason: string }): Promise<{ id: string; status: string }>;
  createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }>;
  transfer(input: { amount: number; recipientCode: string; reference: string; reason: string }): Promise<{ transferId?: string }>;
}
