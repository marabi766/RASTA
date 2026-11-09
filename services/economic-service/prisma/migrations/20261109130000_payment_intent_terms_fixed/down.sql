-- Reverse of `migration.sql` (20261109130000_payment_intent_terms_fixed).
--
-- Drops the two triggers and their function. Nothing was rewritten going up, so nothing is put
-- back; the service names neither, so the release need not be rolled back first.
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER "trg_payment_intent_no_truncate" ON "payment_intent";
DROP TRIGGER "trg_payment_intent_terms_fixed" ON "payment_intent";
DROP FUNCTION reject_payment_intent_rewrite();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109130000_payment_intent_terms_fixed';

COMMIT;
