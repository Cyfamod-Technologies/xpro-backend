-- Ledger of the data seeds (src/seeds) applied to this database. Schema only; no data.

-- CreateTable
CREATE TABLE "data_seeds" (
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checksum" TEXT,

    CONSTRAINT "data_seeds_pkey" PRIMARY KEY ("name")
);
