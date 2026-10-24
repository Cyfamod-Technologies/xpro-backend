-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('submitted', 'under_review', 'matched', 'quoted', 'awaiting_payment', 'ready_to_schedule', 'scheduled', 'in_progress', 'blocked', 'completion_pending', 'acknowledged', 'cancelling', 'closed', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "IntakeState" AS ENUM ('pending', 'clarification', 'approved');

-- CreateEnum
CREATE TYPE "ContactMethod" AS ENUM ('email', 'phone', 'both');

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "NeedsAssignmentReason" AS ENUM ('manual_mode', 'no_eligible', 'limit_reached', 'declined', 'expired', 'acceptance_rejected', 'withdrawn', 'replaced', 'provider_suspended', 'edited');

-- CreateEnum
CREATE TYPE "HoldKind" AS ENUM ('staff', 'no_show', 'provider_suspended', 'customer_suspended');

-- CreateEnum
CREATE TYPE "AcknowledgedBy" AS ENUM ('customer', 'system', 'staff');

-- CreateEnum
CREATE TYPE "DispatchTrigger" AS ENUM ('intake_approved', 'cascade', 'staff_auto', 'staff_view', 'edited', 'replace');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('offered', 'pending_approval', 'accepted', 'declined', 'expired', 'not_confirmed', 'withdrawn', 'replaced', 'completed');

-- CreateEnum
CREATE TYPE "AssignmentEndReason" AS ENUM ('declined', 'expired', 'acceptance_rejected', 'withdrawn', 'replaced', 'provider_suspended', 'request_edited', 'request_cancelled', 'request_rejected', 'request_closed');

-- CreateEnum
CREATE TYPE "AssignmentSource" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'revision_requested', 'superseded', 'expired');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('proposed', 'confirmed', 'changes_requested', 'cancelled', 'superseded');

-- CreateEnum
CREATE TYPE "PartyResponse" AS ENUM ('pending', 'accepted', 'changes_requested');

-- CreateEnum
CREATE TYPE "UpdateKind" AS ENUM ('start', 'progress', 'blocker', 'resume', 'completion', 'rework', 'rework_completion');

-- CreateEnum
CREATE TYPE "UpdateTarget" AS ENUM ('in_progress', 'blocked', 'completion_pending');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "IssueWindow" AS ENUM ('completion', 'defects');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('open', 'rework', 'disputed', 'resolved');

-- CreateEnum
CREATE TYPE "IssueResolvedWith" AS ENUM ('rework', 'no_rework', 'dispute_decision');

-- CreateEnum
CREATE TYPE "CancellationStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn', 'completed');

-- CreateEnum
CREATE TYPE "CancellationRequester" AS ENUM ('customer', 'staff', 'system');

-- CreateEnum
CREATE TYPE "CancellationReason" AS ENUM ('customer_changed_mind', 'quote_declined', 'no_response', 'payment_lapsed', 'no_provider', 'provider_no_show', 'provider_suspended', 'customer_suspended', 'scope_dispute', 'duplicate', 'other');

-- CreateEnum
CREATE TYPE "NoShowStatus" AS ENUM ('open', 'confirmed', 'dismissed', 'voided');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('customer', 'provider', 'internal');

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "owner_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contact_method" "ContactMethod" NOT NULL DEFAULT 'phone',
    "description" TEXT NOT NULL,
    "budget" BIGINT NOT NULL DEFAULT 0,
    "start_date" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" "RequestStatus" NOT NULL DEFAULT 'submitted',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contact_in_brief" BOOLEAN NOT NULL DEFAULT false,
    "possible_duplicate_of" TEXT,
    "intake_state" "IntakeState" NOT NULL DEFAULT 'pending',
    "clarification_asked_at" TIMESTAMP(3),
    "clarification_count" INTEGER NOT NULL DEFAULT 0,
    "intake_approved_by" TEXT,
    "intake_approved_at" TIMESTAMP(3),
    "offer_brief" TEXT,
    "share_on_confirm" JSONB NOT NULL DEFAULT '{"description":true,"attachmentIds":[]}',
    "staff_owner_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "unclaimed_since" TIMESTAMP(3),
    "ownership_version" INTEGER NOT NULL DEFAULT 1,
    "dispatch_mode" "DispatchMode" NOT NULL DEFAULT 'auto',
    "auto_attempts" INTEGER NOT NULL DEFAULT 0,
    "needs_assignment_reason" "NeedsAssignmentReason",
    "last_run_id" TEXT,
    "hold_kind" "HoldKind",
    "hold_by" TEXT,
    "hold_reason" TEXT,
    "hold_at" TIMESTAMP(3),
    "hold_previous_status" "RequestStatus",
    "issue_cycles" INTEGER NOT NULL DEFAULT 0,
    "report_approved_at" TIMESTAMP(3),
    "confirm_due_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" "AcknowledgedBy",
    "acknowledged_note" TEXT,
    "defects_window_ends_at" TIMESTAMP(3),
    "cancellation_id" TEXT,
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_attachments" (
    "request_id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "shared_with_provider" BOOLEAN NOT NULL DEFAULT false,
    "shared_at" TIMESTAMP(3),
    "shared_by" TEXT,

    CONSTRAINT "request_attachments_pkey" PRIMARY KEY ("request_id","upload_id")
);

-- CreateTable
CREATE TABLE "request_edits" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "by_id" TEXT NOT NULL,
    "by_role" TEXT NOT NULL,
    "note" TEXT,
    "redispatched" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_edits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_runs" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "trigger" "DispatchTrigger" NOT NULL,
    "actor_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "settings" JSONB NOT NULL,
    "eligible" JSONB NOT NULL,
    "excluded" JSONB NOT NULL,
    "outcome" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'offered',
    "end_reason" "AssignmentEndReason",
    "source" "AssignmentSource" NOT NULL,
    "attempt" INTEGER,
    "ranking_run_id" TEXT,
    "score" JSONB,
    "override_note" TEXT,
    "overridden_rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "offered_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "response" TEXT,
    "crew_confirmed" INTEGER,
    "responded_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "shared_details" JSONB,
    "ended_at" TIMESTAMP(3),
    "ended_by" TEXT,
    "work_started" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contributions" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "total" BIGINT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "items" JSONB NOT NULL,
    "total" BIGINT NOT NULL,
    "note" TEXT,
    "based_on_assignment_id" TEXT,
    "pricing_override_note" TEXT,
    "last_edited_by" TEXT NOT NULL,
    "approval_requested_by" TEXT,
    "approval_requested_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "returned_note" TEXT,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "response_note" TEXT,
    "accepted_at" TIMESTAMP(3),
    "payment_due_at" TIMESTAMP(3),
    "provider_changed_at" TIMESTAMP(3),
    "payout_amount" BIGINT,
    "payout_assignment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'proposed',
    "customer" "PartyResponse" NOT NULL DEFAULT 'pending',
    "provider" "PartyResponse" NOT NULL DEFAULT 'pending',
    "responses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replaces_schedule_id" TEXT,
    "change_requests" JSONB NOT NULL DEFAULT '[]',
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_updates" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "kind" "UpdateKind" NOT NULL,
    "target" "UpdateTarget" NOT NULL,
    "note" TEXT NOT NULL,
    "issue_id" TEXT,
    "on_behalf" JSONB,
    "state" "ReviewState" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "system_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "window" "IssueWindow" NOT NULL,
    "note" TEXT NOT NULL,
    "raised_by" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL,
    "cycle" INTEGER NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'open',
    "accepted_by" TEXT,
    "accepted_at" TIMESTAMP(3),
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_with" "IssueResolvedWith",
    "evidence_update_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellations" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" "CancellationStatus" NOT NULL DEFAULT 'pending',
    "requested_by" "CancellationRequester" NOT NULL,
    "requested_by_id" TEXT,
    "reason_code" "CancellationReason" NOT NULL,
    "note" TEXT NOT NULL,
    "stage" "RequestStatus" NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "work_started" BOOLEAN NOT NULL DEFAULT false,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "refund_due" BOOLEAN NOT NULL DEFAULT false,
    "compensation_candidate_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "no_shows" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "status" "NoShowStatus" NOT NULL DEFAULT 'open',
    "detected_at" TIMESTAMP(3) NOT NULL,
    "reported_by" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "no_shows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_messages" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "provider_id" TEXT,
    "author_id" TEXT,
    "author_role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_messages_pkey" PRIMARY KEY ("id")
);

-- Add PostgreSQL constraints and indexes that Prisma cannot represent.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX audit_logs_request_id ON audit_logs ((metadata->>'requestId'));

CREATE UNIQUE INDEX assignments_one_current
  ON assignments (request_id)
  WHERE status IN ('offered', 'pending_approval', 'accepted');

CREATE UNIQUE INDEX cancellations_one_pending
  ON cancellations (request_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX no_shows_one_open
  ON no_shows (schedule_id)
  WHERE status = 'open';

ALTER TABLE schedules
  ADD CONSTRAINT schedules_end_after_start CHECK (end_at > start_at);

ALTER TABLE schedules
  ADD CONSTRAINT schedules_no_confirmed_overlap
  EXCLUDE USING gist (
    provider_id WITH =,
    tsrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (status = 'confirmed');

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_number_key" ON "service_requests"("number");

-- CreateIndex
CREATE INDEX "service_requests_owner_id_status_idx" ON "service_requests"("owner_id", "status");

-- CreateIndex
CREATE INDEX "service_requests_status_intake_state_idx" ON "service_requests"("status", "intake_state");

-- CreateIndex
CREATE INDEX "service_requests_staff_owner_id_status_idx" ON "service_requests"("staff_owner_id", "status");

-- CreateIndex
CREATE INDEX "service_requests_service_district_id_created_at_idx" ON "service_requests"("service", "district_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "request_attachments_upload_id_key" ON "request_attachments"("upload_id");

-- CreateIndex
CREATE INDEX "request_edits_request_id_created_at_idx" ON "request_edits"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "dispatch_runs_request_id_created_at_idx" ON "dispatch_runs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "assignments_request_id_status_idx" ON "assignments"("request_id", "status");

-- CreateIndex
CREATE INDEX "assignments_provider_id_status_idx" ON "assignments"("provider_id", "status");

-- CreateIndex
CREATE INDEX "assignments_provider_user_id_status_idx" ON "assignments"("provider_user_id", "status");

-- CreateIndex
CREATE INDEX "contributions_request_id_assignment_id_created_at_idx" ON "contributions"("request_id", "assignment_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_request_id_status_idx" ON "quotes"("request_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_request_id_version_key" ON "quotes"("request_id", "version");

-- CreateIndex
CREATE INDEX "schedules_request_id_status_idx" ON "schedules"("request_id", "status");

-- CreateIndex
CREATE INDEX "schedules_provider_id_status_start_at_idx" ON "schedules"("provider_id", "status", "start_at");

-- CreateIndex
CREATE INDEX "progress_updates_request_id_state_created_at_idx" ON "progress_updates"("request_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "issues_request_id_status_idx" ON "issues"("request_id", "status");

-- CreateIndex
CREATE INDEX "cancellations_request_id_status_idx" ON "cancellations"("request_id", "status");

-- CreateIndex
CREATE INDEX "no_shows_request_id_status_idx" ON "no_shows"("request_id", "status");

-- CreateIndex
CREATE INDEX "request_messages_request_id_channel_created_at_idx" ON "request_messages"("request_id", "channel", "created_at");

-- AddForeignKey
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_edits" ADD CONSTRAINT "request_edits_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_runs" ADD CONSTRAINT "dispatch_runs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_shows" ADD CONSTRAINT "no_shows_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_messages" ADD CONSTRAINT "request_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
