ALTER TABLE "users"
  ADD COLUMN "phone_e164" TEXT,
  ADD COLUMN "phone_verified_at" TIMESTAMP(3);

CREATE TABLE "phone_verifications" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "phone_e164" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "phone_verifications_user_id_created_at_idx" ON "phone_verifications"("user_id", "created_at");
CREATE INDEX "phone_verifications_phone_e164_created_at_idx" ON "phone_verifications"("phone_e164", "created_at");

-- The referencing table is new and empty; existing users need no backfill.
-- squawk-ignore constraint-missing-not-valid,adding-foreign-key-constraint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
