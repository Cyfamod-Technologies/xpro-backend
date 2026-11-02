ALTER TABLE "request_counter_offers"
  ADD COLUMN "accepted_at" TIMESTAMP(3),
  ADD COLUMN "accepted_by" TEXT,
  ADD CONSTRAINT "request_counter_offers_acceptance_pair_check"
    CHECK (("accepted_at" IS NULL) = ("accepted_by" IS NULL));
