-- CreateEnum
CREATE TYPE "FeaturedProviderMode" AS ENUM ('pinned', 'hidden');

-- CreateTable
CREATE TABLE "featured_providers" (
    "provider_id" TEXT NOT NULL,
    "mode" "FeaturedProviderMode" NOT NULL,
    "position" INTEGER,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "featured_providers_pkey" PRIMARY KEY ("provider_id")
);

-- CreateIndex
CREATE INDEX "featured_providers_mode_position_idx" ON "featured_providers"("mode", "position");

-- AddForeignKey
ALTER TABLE "featured_providers" ADD CONSTRAINT "featured_providers_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
