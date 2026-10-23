-- CreateTable
CREATE TABLE "in_app_notifications" (
    "id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "request_id" TEXT,
    "link" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "in_app_notifications_recipient_id_read_at_created_at_idx" ON "in_app_notifications"("recipient_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_created_at_idx" ON "outbox_events"("processed_at", "created_at");
