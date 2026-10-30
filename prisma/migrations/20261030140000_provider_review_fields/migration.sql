-- Names of the profile fields a held change touched, shown in the provider's review history. Older rows are empty.
ALTER TABLE "provider_reviews" ADD COLUMN "fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
