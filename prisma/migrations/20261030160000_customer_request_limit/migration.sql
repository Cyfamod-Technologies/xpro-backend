-- Open-request limit (MS-6, MS-7): a per-customer override of request.maxOpenPerCustomer.
-- Additive only. NULL means the platform setting applies, so existing users need no backfill.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "open_request_limit" INTEGER;

-- Prisma has no CHECK syntax; the range is also validated in the service.
ALTER TABLE "users" ADD CONSTRAINT "users_open_request_limit_range"
    CHECK ("open_request_limit" IS NULL OR "open_request_limit" BETWEEN 1 AND 50);
