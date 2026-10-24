CREATE TYPE "PaymentMethod" AS ENUM ('paystack', 'offline');
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'recorded', 'paid', 'failed', 'partially_refunded', 'refunded', 'reversed');
CREATE TYPE "RefundStatus" AS ENUM ('pending_approval', 'approved', 'processing', 'completed', 'rejected', 'waived', 'failed');
CREATE TYPE "PayoutKind" AS ENUM ('primary', 'compensation');
CREATE TYPE "PayoutStatus" AS ENUM ('pending_approval', 'awaiting_second_approval', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'cancelled', 'reversed');

ALTER TABLE "provider_bank_accounts" ADD COLUMN "recipient_code_enc" TEXT;

CREATE TABLE "payments" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "quote_id" TEXT NOT NULL,
  "quote_version" INTEGER NOT NULL,
  "amount" BIGINT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "channel" TEXT,
  "status" "PaymentStatus" NOT NULL,
  "reference" TEXT NOT NULL,
  "gateway_transaction_id" TEXT,
  "gateway_channel" TEXT,
  "paid_at" TIMESTAMP(3),
  "proof_upload_id" TEXT,
  "recorded_by" TEXT,
  "reconciled_by" TEXT,
  "reconciled_at" TIMESTAMP(3),
  "note" TEXT,
  "failure_reason" TEXT,
  "late_refund_opened" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");
CREATE UNIQUE INDEX "payments_gateway_transaction_id_key" ON "payments"("gateway_transaction_id");
CREATE INDEX "payments_request_id_status_idx" ON "payments"("request_id", "status");

CREATE TABLE "refunds" (
  "id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "cancellation_id" TEXT,
  "amount" BIGINT NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'pending_approval',
  "reason" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "decided_by" TEXT,
  "second_approver" TEXT,
  "transfer_reference" TEXT,
  "transfer_proof_id" TEXT,
  "transfer_recorded_by" TEXT,
  "gateway_refund_id" TEXT,
  "reconciled_by" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refunds_gateway_refund_id_key" ON "refunds"("gateway_refund_id");
CREATE INDEX "refunds_request_id_status_idx" ON "refunds"("request_id", "status");

CREATE TABLE "payouts" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "kind" "PayoutKind" NOT NULL DEFAULT 'primary',
  "amount" BIGINT NOT NULL,
  "status" "PayoutStatus" NOT NULL DEFAULT 'pending_approval',
  "hold_reason" TEXT,
  "hold_source" TEXT,
  "approval_due_at" TIMESTAMP(3),
  "bank_account_id" TEXT,
  "bank_last4" TEXT,
  "transfer_reference" TEXT,
  "transfer_proof_id" TEXT,
  "transfer_recorded_by" TEXT,
  "reconciled_by" TEXT,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payouts_request_id_kind_idx" ON "payouts"("request_id", "kind");
CREATE INDEX "payouts_status_idx" ON "payouts"("status");
CREATE UNIQUE INDEX "payouts_one_primary" ON "payouts"("request_id") WHERE "kind" = 'primary' AND "status" <> 'cancelled';

CREATE TABLE "payout_approvals" (
  "id" TEXT NOT NULL,
  "payout_id" TEXT NOT NULL,
  "step" INTEGER NOT NULL,
  "actor_id" TEXT NOT NULL,
  "note" TEXT,
  "bank_version" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_approvals_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "transfer_attempts" (
  "id" TEXT NOT NULL,
  "payout_id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "gateway_transfer_id" TEXT,
  "amount" BIGINT NOT NULL,
  "status" TEXT NOT NULL,
  "failure_code" TEXT,
  "submitted_at" TIMESTAMP(3) NOT NULL,
  "settled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transfer_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_attempts_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "transfer_attempts_reference_key" ON "transfer_attempts"("reference");
CREATE UNIQUE INDEX "transfer_attempts_gateway_transfer_id_key" ON "transfer_attempts"("gateway_transfer_id");
CREATE INDEX "transfer_attempts_payout_id_created_at_idx" ON "transfer_attempts"("payout_id", "created_at");

CREATE TABLE "gateway_events" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "reference" TEXT,
  "raw_body_digest" TEXT NOT NULL,
  "signature_valid" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gateway_events_fingerprint_key" ON "gateway_events"("fingerprint");
CREATE INDEX "gateway_events_status_received_at_idx" ON "gateway_events"("status", "received_at");
