-- Reverse of `migration.sql` (20260930210000_payment_intent_unfinished_refund_index).
--
-- Drops two indexes, not data. The reconciler's heal windows still work
-- without them, reading more of each table per sweep.
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ix_payment_intent_unfinished_refund";
DROP INDEX IF EXISTS "ix_payment_reconciliation_open_window";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930210000_payment_intent_unfinished_refund_index';

COMMIT;
