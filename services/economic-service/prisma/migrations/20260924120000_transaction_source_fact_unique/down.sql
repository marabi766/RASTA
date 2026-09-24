-- Reverses 20260924120000_transaction_source_fact_unique.
--
-- Dropping the index removes the guarantee, not any data: rows written while
-- it existed are still one per fact. The check-then-insert in
-- recordAuthorisedObligation is what remains, which is the state before this
-- migration.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_transaction_source_fact";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260924120000_transaction_source_fact_unique';
