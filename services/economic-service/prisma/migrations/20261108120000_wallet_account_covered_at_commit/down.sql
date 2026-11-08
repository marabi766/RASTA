-- Reverse of `migration.sql` (20261108120000_wallet_account_covered_at_commit).
--
-- Drops the trigger and its function. Nothing was rewritten going up, so nothing is put back; the
-- service never names either, so the release need not be rolled back first.
BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "ledger_entry" IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER "trg_ledger_entry_wallet_covered" ON "ledger_entry";
DROP FUNCTION assert_wallet_account_covered();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108120000_wallet_account_covered_at_commit';

COMMIT;
