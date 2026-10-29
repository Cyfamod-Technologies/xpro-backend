-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('yes_no', 'single_choice', 'multiple_choice', 'short_text', 'long_text', 'number', 'date');

-- CreateEnum
CREATE TYPE "DateRole" AS ENUM ('start', 'end');

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN     "answers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "service_id" TEXT,
ADD COLUMN     "service_path" JSONB,
ADD COLUMN     "service_root_id" TEXT;

-- CreateTable
CREATE TABLE "catalog_services" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requires_start_date" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_questions" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "help_text" TEXT,
    "type" "QuestionType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "options" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB NOT NULL DEFAULT '{}',
    "date_role" "DateRole",
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "matches_skill" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_services_parent_id_sort_order_idx" ON "catalog_services"("parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_services_parent_id_name_key" ON "catalog_services"("parent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "service_questions_service_id_key_key" ON "service_questions"("service_id", "key");

-- CreateIndex
CREATE INDEX "service_requests_service_root_id_idx" ON "service_requests"("service_root_id");

-- AddForeignKey
ALTER TABLE "catalog_services" ADD CONSTRAINT "catalog_services_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "catalog_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_questions" ADD CONSTRAINT "service_questions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "catalog_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- squawk-ignore constraint-missing-not-valid,adding-foreign-key-constraint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "catalog_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- squawk-ignore constraint-missing-not-valid,adding-foreign-key-constraint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_service_root_id_fkey" FOREIGN KEY ("service_root_id") REFERENCES "catalog_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
