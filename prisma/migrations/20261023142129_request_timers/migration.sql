-- CreateEnum
CREATE TYPE "TimerStatus" AS ENUM ('pending', 'running', 'done', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "request_timers" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL DEFAULT '',
    "due_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "status" "TimerStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "fired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_timers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_timers_status_due_at_idx" ON "request_timers"("status", "due_at");

-- CreateIndex
CREATE INDEX "request_timers_request_id_status_idx" ON "request_timers"("request_id", "status");

-- At most one pending timer per request, kind and reference (06 §4.4).
CREATE UNIQUE INDEX "request_timers_one_pending" ON "request_timers"("request_id", "kind", "ref_id") WHERE "status" = 'pending';
