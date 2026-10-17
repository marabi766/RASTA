-- Reverse of `migration.sql` (20261017125000_transaction_source_quarantine).
--
-- Refuses while any quarantine row exists. Each is the only record of the
-- source key its transaction carried before the key was taken off it — the
-- transaction itself now holds none — and of the decision behind taking it.
-- Dropping the table would lose both, so a rollback is possible only on a
-- database where nothing was quarantined. Run 20261017130000's down.sql first.
--
-- One transaction, the table lock first: a quarantine being written is either
-- counted, so the rollback refuses, or waits and then fails.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE quarantined BIGINT := 0;
BEGIN
  IF to_regclass('transaction_source_quarantine') IS NOT NULL THEN
    LOCK TABLE "transaction_source_quarantine" IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO quarantined FROM "transaction_source_quarantine";
  END IF;
  IF quarantined > 0 THEN
    RAISE EXCEPTION 'transaction_source_quarantine holds % row(s); refusing to drop the source keys they keep',
      quarantined
      USING HINT = 'Each is the only record of the source key its transaction carried, and of the decision to take it off.';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS quarantine_transaction_source(TEXT, TEXT);
DROP TABLE IF EXISTS "transaction_source_quarantine";
DROP FUNCTION IF EXISTS reject_transaction_source_quarantine_mutation();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017125000_transaction_source_quarantine';

COMMIT;
