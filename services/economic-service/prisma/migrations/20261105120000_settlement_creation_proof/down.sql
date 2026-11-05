-- Reverse of `migration.sql` (20261105120000_settlement_creation_proof).
--
-- Drops the proofs, the two foreign keys, the transaction's two guards, the guard on
-- a reversal and the quarantine. Refuses nothing: no row is touched, and the quarantine holds nothing
-- that is not still on the rows themselves, which the next up finds again.
-- Rows written after this runs are not proven by anything until it is applied again.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "journal", "commission", "settlement", "transaction", "settlement_reversal"
  IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER "trg_transaction_status_edges" ON "transaction";
DROP FUNCTION enforce_transaction_settlement_edges();
DROP TRIGGER "trg_transaction_terms_fixed" ON "transaction";
DROP FUNCTION reject_transaction_terms_change();
DROP TRIGGER "trg_transaction_settled_proven" ON "transaction";

DROP TRIGGER "trg_commission_no_truncate" ON "commission";
DROP FUNCTION reject_commission_truncate();
DROP TRIGGER "trg_commission_creation_proven" ON "commission";
DROP TRIGGER "trg_settlement_creation_proven" ON "settlement";
DROP FUNCTION assert_settlement_creation_proven();
ALTER TABLE "commission" DROP CONSTRAINT "commission_journal_id_fkey";
ALTER TABLE "settlement" DROP CONSTRAINT "settlement_journal_id_fkey";
DROP TRIGGER "trg_settlement_reversal_not_quarantined" ON "settlement_reversal";
DROP FUNCTION reject_settlement_reversal_of_quarantined();
DROP TABLE "settlement_creation_quarantine";
DROP FUNCTION reject_settlement_creation_quarantine_change();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105120000_settlement_creation_proof';

COMMIT;
