-- Reverse of `migration.sql` (20261104120000_settlement_reversal).
--
-- Drops `settlement_reversal`, every trigger the migration added and
-- `ck_transaction_reversed_settled`, and rebuilds `TransactionStatus`
-- and `JournalType` without the values the migration added (PostgreSQL has no
-- DROP VALUE). Roll the code back first.
--
-- **Refuses, and changes nothing, while anything uses them:** a case of any
-- status, a transaction PARTIALLY_REVERSED or REVERSED, a SETTLEMENT_REVERSAL
-- journal. Each is the record of a decision about money, and the older enums
-- cannot hold it. Reversals are forward-only from the first case.
--
-- Rebuilding a type rewrites `transaction` and `journal` under ACCESS EXCLUSIVE:
-- on a large database raise the 5 s bound for this one run with
-- `RASTA_MIGRATION_STATEMENT_TIMEOUT`, and take a window for it.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

-- Locked first, so nothing can be written between the check and the changes.
LOCK TABLE "settlement_reversal", "transaction", "journal", "ledger_entry", "settlement"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_settlement_reversal$
BEGIN
  IF EXISTS (SELECT 1 FROM "settlement_reversal")
     OR EXISTS (SELECT 1 FROM "transaction" WHERE "status"::text IN ('PARTIALLY_REVERSED', 'REVERSED'))
     OR EXISTS (SELECT 1 FROM "journal" WHERE "journal_type"::text = 'SETTLEMENT_REVERSAL') THEN
    RAISE EXCEPTION 'down refused: a settlement reversal exists; nothing was changed'
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_settlement_reversal$;

DROP TRIGGER "trg_settlement_figures_fixed" ON "settlement";
DROP TRIGGER "trg_journal_settlement_reversal_final" ON "journal";
DROP TRIGGER "trg_ledger_entry_settlement_reversal_closed" ON "ledger_entry";
DROP TRIGGER "trg_journal_settlement_reversal_owned" ON "journal";
DROP TRIGGER "trg_transaction_reversal_status" ON "transaction";
DROP TABLE "settlement_reversal";
DROP FUNCTION reject_settlement_figures_change();
DROP FUNCTION reject_settlement_reversal_journal_undo();
DROP FUNCTION reject_settlement_reversal_journal_leg();
DROP FUNCTION assert_settlement_reversal_journal_owned();
DROP FUNCTION enforce_transaction_reversal_status();
DROP FUNCTION assert_settlement_reversal_status_moved();
DROP FUNCTION reject_settlement_reversal_removal();
DROP FUNCTION enforce_settlement_reversal_change();
DROP TYPE "SettlementReversalStatus";
DROP TYPE "SettlementReversalSource";

-- ---- JournalType, without SETTLEMENT_REVERSAL ----------------------------------
-- What depends on the column goes and comes back, verbatim: a CHECK parsed
-- against the renamed type would no longer compare with the new one.
ALTER TABLE "journal" DROP CONSTRAINT "ck_journal_reversal_shape";

ALTER TYPE "JournalType" RENAME TO "JournalType_with_reversal";
CREATE TYPE "JournalType" AS ENUM ('WALLET_TOP_UP', 'FUNDS_HELD', 'FUNDS_REFUNDED', 'SETTLEMENT', 'REWARD_GRANT', 'REVERSAL');
ALTER TABLE "journal"
  ALTER COLUMN "journal_type" TYPE "JournalType" USING "journal_type"::text::"JournalType";
DROP TYPE "JournalType_with_reversal";

ALTER TABLE "journal"
  ADD CONSTRAINT "ck_journal_reversal_shape"
  CHECK (
    ("journal_type" = 'REVERSAL' AND "reverses_id" IS NOT NULL AND "reversal_reason" IS NOT NULL)
    OR
    ("journal_type" <> 'REVERSAL' AND "reverses_id" IS NULL AND "reversal_reason" IS NULL)
  );

-- ---- TransactionStatus, without the two reversal statuses ----------------------
DROP TRIGGER "trg_transaction_dispute_identity" ON "transaction";
DROP TRIGGER "trg_transaction_resolved_dispute" ON "transaction";
DROP TRIGGER "trg_transaction_dispute_resolution" ON "transaction";
DROP TRIGGER "trg_transaction_settlement_authority" ON "transaction";
ALTER TABLE "transaction"
  DROP CONSTRAINT "ck_transaction_reversed_settled",
  DROP CONSTRAINT "ck_transaction_amounts",
  DROP CONSTRAINT "ck_transaction_settled_at",
  DROP CONSTRAINT "ck_transaction_dispute",
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "TransactionStatus" RENAME TO "TransactionStatus_with_reversal";
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'HELD', 'PENDING_SETTLEMENT', 'DISPUTED', 'SETTLED', 'REFUNDED', 'CANCELLED', 'FAILED');
ALTER TABLE "transaction"
  ALTER COLUMN "status" TYPE "TransactionStatus" USING "status"::text::"TransactionStatus";
DROP TYPE "TransactionStatus_with_reversal";

ALTER TABLE "transaction"
  ALTER COLUMN "status" SET DEFAULT 'CREATED',
  ADD CONSTRAINT "ck_transaction_amounts"
  CHECK (
    "gross_amount_minor" > 0 AND
    "commission_amount_minor" >= 0 AND
    "net_amount_minor" >= 0 AND
    "commission_amount_minor" <= "gross_amount_minor" AND
    ("status" <> 'SETTLED' OR
      "net_amount_minor" = "gross_amount_minor" - "commission_amount_minor")
  ),
  ADD CONSTRAINT "ck_transaction_settled_at"
  CHECK ("status" <> 'SETTLED' OR "settled_at" IS NOT NULL),
  ADD CONSTRAINT "ck_transaction_dispute"
  CHECK (
    "status" <> 'DISPUTED' OR ("disputed_at" IS NOT NULL AND "dispute_reason" IS NOT NULL)
  );

CREATE TRIGGER "trg_transaction_dispute_identity"
  BEFORE INSERT OR UPDATE OF "status", "dispute_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION assign_transaction_dispute_identity();
CREATE TRIGGER "trg_transaction_resolved_dispute"
  BEFORE INSERT OR UPDATE OF "status", "resolved_dispute_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION assign_transaction_resolved_dispute();
CREATE TRIGGER "trg_transaction_dispute_resolution"
  BEFORE UPDATE OF "status" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_dispute_resolution();
CREATE TRIGGER "trg_transaction_settlement_authority"
  BEFORE UPDATE OF "status" ON "transaction"
  FOR EACH ROW
  WHEN (NEW."status" = 'SETTLED' AND OLD."status" IS DISTINCT FROM 'SETTLED')
  EXECUTE FUNCTION enforce_transaction_settlement_authority();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104120000_settlement_reversal';

COMMIT;
