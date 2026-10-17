-- Reverse of `migration.sql` (20261017130000_transaction_recorded_source).
--
-- Drops the CHECK that reserves source_type MAINTENANCE_REQUEST and
-- PAYMENT_INTENT for economic-service's own writers. Run with the previous
-- release deployed. Nothing is refused and no row is touched: every row the
-- CHECK admitted stays exactly as it is, still unique per (payer, source type,
-- reference) under ux_transaction_source_fact. What the rollback gives up is
-- the database's refusal of such a row written by anyone else — and the
-- previous release's POST /v1/transactions does not refuse it either, which is
-- the residual of running it.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "ck_transaction_recorded_source";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017130000_transaction_recorded_source';

COMMIT;
