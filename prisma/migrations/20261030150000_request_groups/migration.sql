-- Multi-service requests (MS-1): a light link between the requests created by one submission.
-- Additive only. Existing requests keep group_id and group_position NULL.

-- The human id XPG-nnnnn. Read with nextval() when a group is created; gaps are fine.
CREATE SEQUENCE "request_group_ref_seq";

-- CreateTable
CREATE TABLE "request_groups" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_groups_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN "group_id" TEXT,
ADD COLUMN "group_position" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "request_groups_ref_key" ON "request_groups"("ref");

-- CreateIndex
CREATE INDEX "service_requests_group_id_idx" ON "service_requests"("group_id");

-- AddForeignKey
ALTER TABLE "request_groups" ADD CONSTRAINT "request_groups_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "request_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
