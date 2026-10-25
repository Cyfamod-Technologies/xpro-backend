import type { Payment } from '@prisma/client';

/** What staff with `payment.record` see after recording, reconciling or rejecting a payment. Gateway ids and internal flags stay server-side. */
export type PaymentDto = {
  id: string;
  requestId: string;
  quoteId: string;
  quoteVersion: number;
  amount: number;
  method: string;
  channel: string | null;
  status: string;
  reference: string;
  paidAt: Date | null;
  note: string | null;
  failureReason: string | null;
  proofFileId: string | null;
  recordedBy: string | null;
  reconciledBy: string | null;
  reconciledAt: Date | null;
  createdAt: Date;
};

export function toPaymentDto(row: Payment): PaymentDto {
  return {
    id: row.id,
    requestId: row.requestId,
    quoteId: row.quoteId,
    quoteVersion: row.quoteVersion,
    amount: Number(row.amount),
    method: row.method,
    channel: row.channel,
    status: row.status,
    reference: row.reference,
    paidAt: row.paidAt,
    note: row.note,
    failureReason: row.failureReason,
    proofFileId: row.proofUploadId,
    recordedBy: row.recordedBy,
    reconciledBy: row.reconciledBy,
    reconciledAt: row.reconciledAt,
    createdAt: row.createdAt,
  };
}
