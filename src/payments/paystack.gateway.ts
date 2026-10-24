import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentGateway, VerifiedTransaction } from './payment-gateway';

type PaystackResponse<T> = { status: boolean; message: string; data: T };

@Injectable()
export class PaystackGateway implements PaymentGateway {
  constructor(private readonly config: ConfigService) {}

  initialize(input: {
    email: string;
    amount: number;
    reference: string;
    metadata: Record<string, string>;
  }) {
    return this.request<{ authorization_url: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          amount: input.amount,
          reference: input.reference,
          currency: 'NGN',
          metadata: input.metadata,
        }),
      },
    ).then((data) => ({ authorizationUrl: data.authorization_url }));
  }
  verify(reference: string) {
    return this.request<VerifiedTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET' },
    );
  }
  verifyRefund(id: string) {
    return this.request<{
      id: number | string;
      status: string;
      amount?: number;
    }>(`/refund/${encodeURIComponent(id)}`, { method: 'GET' }).then((data) => ({
      id: String(data.id),
      status: data.status,
      amount: data.amount,
    }));
  }
  verifyTransfer(reference: string) {
    return this.request<{
      reference: string;
      status: string;
      id?: number | string;
    }>(`/transfer/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
    }).then((data) => ({
      reference: data.reference,
      status: data.status,
      id: data.id == null ? undefined : String(data.id),
    }));
  }
  refund(input: { reference: string; amount: number; reason: string }) {
    return this.request<{ id: number; status: string }>('/refund', {
      method: 'POST',
      body: JSON.stringify({
        transaction: input.reference,
        amount: input.amount,
        merchant_note: input.reason,
      }),
    }).then((data) => ({ id: String(data.id), status: data.status }));
  }
  createRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }) {
    return this.request<{ recipient_code: string }>('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: input.name,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        currency: 'NGN',
      }),
    }).then((data) => ({ recipientCode: data.recipient_code }));
  }
  transfer(input: {
    amount: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }) {
    return this.request<{ transfer_code: string; id: number }>('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: input.amount,
        recipient: input.recipientCode,
        reference: input.reference,
        reason: input.reason,
      }),
    }).then((data) => ({ transferId: String(data.id) }));
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret)
      throw new ServiceUnavailableException('Paystack is not configured.');
    let response: Response;
    try {
      response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Paystack is temporarily unavailable.',
      );
    }
    const payload = (await response.json()) as PaystackResponse<T>;
    if (!response.ok || !payload.status)
      throw new ServiceUnavailableException(
        payload.message || 'Paystack could not process the request.',
      );
    return payload.data;
  }
}
