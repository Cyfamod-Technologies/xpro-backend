ALTER TABLE "provider_profiles"
  ADD COLUMN "last_offered_at" TIMESTAMP(3),
  ADD COLUMN "reliability_status" TEXT NOT NULL DEFAULT 'normal';

CREATE TABLE "provider_reliability_events" (
  "id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "request_id" TEXT,
  "source_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "confirmed_by" TEXT,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_reliability_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_reliability_events_source_id_key"
  ON "provider_reliability_events"("source_id");
CREATE INDEX "provider_reliability_events_provider_id_occurred_at_idx"
  ON "provider_reliability_events"("provider_id", "occurred_at");
