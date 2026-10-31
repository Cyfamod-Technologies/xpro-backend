ALTER TYPE "RequestStatus" ADD VALUE 'approved';
ALTER TYPE "ContactMethod" ADD VALUE 'whatsapp';

CREATE TYPE "RequestWorkflow" AS ENUM ('phase2', 'v1');
CREATE TYPE "MessageKind" AS ENUM ('text', 'counter');
CREATE TYPE "RequestDecisionOutcome" AS ENUM ('approved', 'denied');
CREATE TYPE "RequestActivityKind" AS ENUM (
  'submitted',
  'assigned',
  'reassigned',
  'approved',
  'denied',
  'cancelled',
  'provider_assigned',
  'provider_replaced'
);

ALTER TABLE "service_requests"
  ADD COLUMN "workflow_mode" "RequestWorkflow" NOT NULL DEFAULT 'phase2';
CREATE INDEX "service_requests_workflow_mode_status_created_at_idx"
  ON "service_requests"("workflow_mode", "status", "created_at");
CREATE INDEX "service_requests_workflow_mode_staff_owner_id_status_idx"
  ON "service_requests"("workflow_mode", "staff_owner_id", "status");
CREATE INDEX "service_requests_workflow_mode_owner_id_created_at_idx"
  ON "service_requests"("workflow_mode", "owner_id", "created_at");

ALTER TABLE "request_messages"
  ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'text';

CREATE TABLE "request_decisions" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "outcome" "RequestDecisionOutcome" NOT NULL,
  "reason" TEXT,
  "decided_by_id" TEXT NOT NULL,
  "decided_by_name" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "provider_profile_id" TEXT,
  "price_kobo" BIGINT NOT NULL,
  "agreed_date" TEXT NOT NULL,
  "based_on_counter_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_decisions_request_id_key" UNIQUE ("request_id"),
  CONSTRAINT "request_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_decisions_provider_profile_id_fkey" FOREIGN KEY ("provider_profile_id") REFERENCES "provider_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "request_decisions_outcome_fields" CHECK (
    ("outcome" = 'approved' AND "reason" IS NULL AND (("provider_profile_id" IS NULL AND "price_kobo" IS NULL AND "agreed_date" IS NULL) OR ("provider_profile_id" IS NOT NULL AND "price_kobo" > 0 AND "agreed_date" IS NOT NULL)))
    OR
    ("outcome" = 'denied' AND "reason" IS NOT NULL AND char_length("reason") >= 10 AND "provider_profile_id" IS NULL AND "price_kobo" IS NULL AND "agreed_date" IS NULL)
  )
);

CREATE TABLE "request_provider_assignments" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "provider_profile_id" TEXT NOT NULL,
  "provider_user_id" TEXT NOT NULL,
  "assigned_by_id" TEXT NOT NULL,
  "assigned_by_name" TEXT NOT NULL,
  "assigned_at" TIMESTAMP(3) NOT NULL,
  "price_kobo" BIGINT,
  "agreed_date" TEXT,
  "ended_at" TIMESTAMP(3),
  "ended_by_id" TEXT,
  "end_reason" TEXT,
  "replaced_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_provider_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_provider_assignments_replaced_by_id_key" UNIQUE ("replaced_by_id"),
  CONSTRAINT "request_provider_assignments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_provider_assignments_provider_profile_id_fkey" FOREIGN KEY ("provider_profile_id") REFERENCES "provider_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "request_provider_assignments_provider_user_id_ended_at_assigned_at_idx"
  ON "request_provider_assignments"("provider_user_id", "ended_at", "assigned_at");
CREATE INDEX "request_provider_assignments_request_id_assigned_at_idx"
  ON "request_provider_assignments"("request_id", "assigned_at");
CREATE UNIQUE INDEX "request_provider_assignments_one_active"
  ON "request_provider_assignments"("request_id") WHERE "ended_at" IS NULL;

CREATE TABLE "request_counter_offers" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "author_role" TEXT NOT NULL,
  "amount_kobo" BIGINT NOT NULL,
  "proposed_date" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "superseded_by_id" TEXT,
  "superseded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_counter_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_counter_offers_message_id_key" UNIQUE ("message_id"),
  CONSTRAINT "request_counter_offers_superseded_by_id_key" UNIQUE ("superseded_by_id"),
  CONSTRAINT "request_counter_offers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_counter_offers_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "request_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_counter_offers_amount_positive" CHECK ("amount_kobo" > 0)
);
CREATE INDEX "request_counter_offers_request_id_created_at_idx"
  ON "request_counter_offers"("request_id", "created_at");
CREATE UNIQUE INDEX "request_counter_offers_one_open"
  ON "request_counter_offers"("request_id") WHERE "superseded_by_id" IS NULL;

CREATE TABLE "request_activities" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "kind" "RequestActivityKind" NOT NULL,
  "actor_id" TEXT,
  "actor_name" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_activities_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "request_activities_request_id_created_at_idx"
  ON "request_activities"("request_id", "created_at");
