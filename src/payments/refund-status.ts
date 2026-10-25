import type { Prisma } from '@prisma/client';

/** Sets a payment to `refunded` or `partially_refunded` from its completed and waived refunds. */
export async function refreshPaymentRefundStatus(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { amount: true },
  });
  const completed = await tx.refund.aggregate({
    where: { paymentId, status: { in: ['completed', 'waived'] } },
    _sum: { amount: true },
  });
  const refundedAmount = completed._sum.amount ?? 0n;
  if (payment && refundedAmount > 0n)
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status:
          refundedAmount >= payment.amount ? 'refunded' : 'partially_refunded',
      },
    });
}
