-- Reverse of `migration.sql` (20261017100000_transaction_statement_obligation).
--
-- Drops the guard and the CHECK that reserve source_type 'STATEMENT' for the
-- STATEMENT_APPROVED consumer. Run with the previous release deployed: it
-- neither consumes STATEMENT_APPROVED nor writes such a row. Nothing is
-- refused and no row is touched: an obligation already recorded stays exactly
-- as it is, still unique per (payer, STATEMENT, statement id) under
-- ux_transaction_source_fact, and still settles through POST /v1/settlements.
-- What the rollback gives up is the database's own refusal to change or delete
-- it, and to let POST /v1/transactions claim the source type — the previous
-- release's API does not refuse it either, which is the residual of running it.
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS "trg_transaction_statement_obligation_fixed" ON "transaction";
DROP FUNCTION IF EXISTS reject_statement_obligation_change();

ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "ck_transaction_statement_obligation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017100000_transaction_statement_obligation';

COMMIT;
