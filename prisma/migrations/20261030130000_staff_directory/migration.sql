-- Staff directory: concurrency version, employment periods, lifecycle details and leave.
ALTER TABLE "staff_members"
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "employment_period" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "suspended_at" TIMESTAMP(3),
  ADD COLUMN "suspended_by" TEXT,
  ADD COLUMN "suspension_reason" TEXT,
  ADD COLUMN "suspension_security_incident" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deactivated_at" TIMESTAMP(3),
  ADD COLUMN "deactivated_by" TEXT,
  ADD COLUMN "deactivation_reason" TEXT,
  ADD COLUMN "leave_from" DATE,
  ADD COLUMN "leave_to" DATE,
  ADD COLUMN "leave_delegate_id" TEXT,
  ADD COLUMN "leave_note" TEXT,
  ADD COLUMN "conflict_declaration" JSONB;

-- Members who are already active were accepted when they were created.
UPDATE "staff_members" SET "accepted_at" = "created_at" WHERE "status" = 'active';
