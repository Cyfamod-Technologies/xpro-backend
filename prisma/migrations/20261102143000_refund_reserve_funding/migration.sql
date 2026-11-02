CREATE TYPE "RefundReserveFundingStatus" AS ENUM (
  'pending_reconciliation',
  'reconciled',
  'rejected'
);

CREATE TABLE "refund_reserve_fundings" (
  "id" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "reference" TEXT NOT NULL,
  "proof_upload_id" TEXT NOT NULL,
  "note" TEXT,
  "status" "RefundReserveFundingStatus" NOT NULL DEFAULT 'pending_reconciliation',
  "recorded_by" TEXT NOT NULL,
  "reconciled_by" TEXT,
  "reconciled_at" TIMESTAMP(3),
  "reconciliation_note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "refund_reserve_fundings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refund_reserve_fundings_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "refund_reserve_fundings_reference_key"
  ON "refund_reserve_fundings"("reference");
CREATE INDEX "refund_reserve_fundings_status_created_at_idx"
  ON "refund_reserve_fundings"("status", "created_at");
