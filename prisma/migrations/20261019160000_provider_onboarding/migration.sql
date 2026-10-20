CREATE TYPE "ProviderVerificationStatus" AS ENUM ('draft', 'pending', 'changes_requested', 'rejected', 'approved', 'delisted');
CREATE TYPE "ProviderBankStatus" AS ENUM ('pending', 'verified', 'rejected', 'superseded');
CREATE TYPE "ProviderUploadPurpose" AS ENUM ('provider_document', 'provider_photo', 'provider_portfolio');
CREATE TYPE "ProviderUploadStatus" AS ENUM ('pending', 'ready', 'attached', 'expired');

CREATE TABLE "provider_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "services" JSONB NOT NULL,
    "service_areas" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "working_hours" JSONB NOT NULL,
    "time_off" JSONB NOT NULL DEFAULT '[]',
    "experience" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bio" TEXT NOT NULL,
    "documents" JSONB NOT NULL DEFAULT '[]',
    "photo" JSONB,
    "portfolio" JSONB NOT NULL DEFAULT '[]',
    "verification" "ProviderVerificationStatus" NOT NULL DEFAULT 'draft',
    "available" BOOLEAN NOT NULL DEFAULT false,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "pending_changes" JSONB,
    "changes_review" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_bank_accounts" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number_enc" TEXT NOT NULL,
    "account_name_enc" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "state" "ProviderBankStatus" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_bank_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_reviews" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "actor_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_uploads" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "purpose" "ProviderUploadPurpose" NOT NULL,
    "status" "ProviderUploadStatus" NOT NULL DEFAULT 'pending',
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "attached_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_profiles_user_id_key" ON "provider_profiles"("user_id");
CREATE INDEX "provider_profiles_verification_available_idx" ON "provider_profiles"("verification", "available");
CREATE INDEX "provider_bank_accounts_provider_id_state_idx" ON "provider_bank_accounts"("provider_id", "state");
CREATE UNIQUE INDEX "provider_bank_accounts_one_pending_idx" ON "provider_bank_accounts"("provider_id") WHERE "state" = 'pending';
CREATE UNIQUE INDEX "provider_bank_accounts_one_verified_idx" ON "provider_bank_accounts"("provider_id") WHERE "state" = 'verified';
CREATE INDEX "provider_reviews_provider_id_created_at_idx" ON "provider_reviews"("provider_id", "created_at");
CREATE UNIQUE INDEX "provider_uploads_storage_key_key" ON "provider_uploads"("storage_key");
CREATE INDEX "provider_uploads_owner_id_status_purpose_idx" ON "provider_uploads"("owner_id", "status", "purpose");
CREATE INDEX "provider_uploads_expires_at_idx" ON "provider_uploads"("expires_at");

ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_bank_accounts" ADD CONSTRAINT "provider_bank_accounts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_reviews" ADD CONSTRAINT "provider_reviews_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_uploads" ADD CONSTRAINT "provider_uploads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
