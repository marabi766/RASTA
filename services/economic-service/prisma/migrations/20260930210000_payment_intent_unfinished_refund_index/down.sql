-- Reverse of `migration.sql` (20260930210000_payment_intent_unfinished_refund_index).
--
-- Drops an index, not data. The reconciler's heal query still works without
-- it, reading the whole table each sweep.
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ix_payment_intent_unfinished_refund";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930210000_payment_intent_unfinished_refund_index';

COMMIT;
