CREATE TYPE "UploadPurpose" AS ENUM (
  'request_attachment',
  'message_attachment',
  'progress_evidence',
  'payment_proof'
);

CREATE TYPE "UploadStatus" AS ENUM ('pending', 'ready', 'attached', 'expired');

CREATE TABLE "uploads" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "purpose" "UploadPurpose" NOT NULL,
  "status" "UploadStatus" NOT NULL DEFAULT 'pending',
  "file_name" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "storage_key" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "attached_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uploads_storage_key_key" ON "uploads"("storage_key");
CREATE INDEX "uploads_owner_id_status_purpose_idx" ON "uploads"("owner_id", "status", "purpose");
CREATE INDEX "uploads_entity_type_entity_id_idx" ON "uploads"("entity_type", "entity_id");
CREATE INDEX "uploads_expires_at_idx" ON "uploads"("expires_at");
