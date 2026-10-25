-- Optimistic-concurrency version for refund and payout decisions (05 §11), and the
-- customer note held with a quote that waits for sign-off (04 §6.11).
ALTER TABLE "refunds" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payouts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quotes" ADD COLUMN "customer_note" TEXT;
