-- AlterTable
ALTER TABLE "gateway_events" ADD COLUMN "subject_id" TEXT,
ADD COLUMN "next_attempt_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "gateway_events_status_next_attempt_at_idx" ON "gateway_events"("status", "next_attempt_at");
