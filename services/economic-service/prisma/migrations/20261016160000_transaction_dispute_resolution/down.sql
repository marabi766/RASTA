-- =============================================================================
-- Reverse of `migration.sql` (20261016160000_transaction_dispute_resolution).
--
-- Drops the resolution column. Run with the previous release deployed: it
-- never names the column, and resolves a dispute by writing over
-- `dispute_reason`, as it always did.
--
-- Refuses FIRST, before changing anything, while any row holds a resolution:
-- for those rows the column is the only record of what the resolver decided
-- (the TRANSACTION_STATUS_CHANGED event names who and when, never what), and
-- the reason beside it is what the previous release would have destroyed.
-- Once resolutions have been recorded, the rollback is the application's
-- alone — deploy the previous release and keep this column, which it runs
-- with unchanged (its `migrate deploy` finds nothing pending). The same rule
-- as docs/23 D-054; nothing here moves the text into `dispute_reason`.
--
-- One transaction, the table locked first: a resolution being written is
-- either counted, so the rollback refuses, or waits and then fails.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE resolved BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'transaction'
      AND column_name = 'dispute_resolution'
  ) THEN
    LOCK TABLE "transaction" IN ACCESS EXCLUSIVE MODE;
    EXECUTE 'SELECT count(*) FROM "transaction" WHERE "dispute_resolution" IS NOT NULL'
      INTO resolved;
  END IF;
  IF resolved > 0 THEN
    RAISE EXCEPTION '% transaction(s) hold a dispute resolution; refusing to drop dispute_resolution',
      resolved
      USING HINT = 'The column is the only record of what was decided (docs/23 D-060).';
  END IF;
END
$$;

ALTER TABLE "transaction" DROP COLUMN IF EXISTS "dispute_resolution";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016160000_transaction_dispute_resolution';

COMMIT;
