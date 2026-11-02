CREATE TYPE "FinancialLedgerAccountType" AS ENUM (
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense'
);

CREATE TYPE "FinancialLedgerSide" AS ENUM ('debit', 'credit');

CREATE TABLE "financial_ledger_accounts" (
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "FinancialLedgerAccountType" NOT NULL,
  "normal_side" "FinancialLedgerSide" NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "financial_ledger_accounts_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "financial_ledger_accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);

CREATE TABLE "financial_ledger_journals" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
  "created_by" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_ledger_journals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_ledger_journals_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);

CREATE TABLE "financial_ledger_entries" (
  "id" TEXT NOT NULL,
  "journal_id" TEXT NOT NULL,
  "account_code" TEXT NOT NULL,
  "side" "FinancialLedgerSide" NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
  "request_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "financial_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_ledger_entries_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "financial_ledger_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "financial_ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "financial_ledger_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "financial_ledger_entries_account_code_fkey" FOREIGN KEY ("account_code") REFERENCES "financial_ledger_accounts"("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "financial_ledger_journals_idempotency_key_key"
  ON "financial_ledger_journals"("idempotency_key");
CREATE UNIQUE INDEX "financial_ledger_journals_source_type_source_id_event_key"
  ON "financial_ledger_journals"("source_type", "source_id", "event");
CREATE INDEX "financial_ledger_journals_created_at_id_idx"
  ON "financial_ledger_journals"("created_at", "id");
CREATE INDEX "financial_ledger_journals_source_type_source_id_idx"
  ON "financial_ledger_journals"("source_type", "source_id");
CREATE INDEX "financial_ledger_entries_account_code_currency_created_at_idx"
  ON "financial_ledger_entries"("account_code", "currency", "created_at");
CREATE INDEX "financial_ledger_entries_request_id_created_at_idx"
  ON "financial_ledger_entries"("request_id", "created_at");

CREATE FUNCTION reject_financial_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Financial ledger journals and entries are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "financial_ledger_journals_immutable"
  BEFORE UPDATE OR DELETE ON "financial_ledger_journals"
  FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation();
CREATE TRIGGER "financial_ledger_entries_immutable"
  BEFORE UPDATE OR DELETE ON "financial_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation();
