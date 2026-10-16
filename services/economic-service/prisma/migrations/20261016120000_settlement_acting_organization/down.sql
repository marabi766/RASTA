-- Reverse of `migration.sql` (20261016120000_settlement_acting_organization).
--
-- Drops the acting organization. Run with the previous release deployed: it
-- neither writes nor reads the column — and that release refuses a system
-- administrator's settlement of another organization's transaction (a 500),
-- so it makes no settlement the column would have been needed for.
--
-- Refuses FIRST, before changing anything, while any settlement was made for
-- an organization other than its payer: for those rows the column is the only
-- record of whom the system administrator acted for, and dropping it would
-- erase that from the ledger's history.
--
-- That refusal is the approved behaviour, not a gap (docs/23 D-054): once the
-- feature has been used, the rollback is the APPLICATION's alone — deploy the
-- previous release and keep this column, which that release runs with
-- unchanged (it never names the column; its rows take NULL; its
-- `migrate deploy` finds nothing pending). Nothing here offers to move,
-- archive or drop the attribution instead.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE crossed BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'settlement'
      AND column_name = 'acting_organization_id'
  ) THEN
    LOCK TABLE "settlement" IN ACCESS EXCLUSIVE MODE;
    EXECUTE 'SELECT count(*) FROM "settlement"
             WHERE "acting_organization_id" <> "payer_organization_id"'
      INTO crossed;
  END IF;
  IF crossed > 0 THEN
    RAISE EXCEPTION 'settlement holds % row(s) made for an organization other than the payer; refusing to drop acting_organization_id',
      crossed
      USING HINT = 'Those rows are the only record of whom a system administrator acted for (docs/23 D-054).';
  END IF;
END
$$;

ALTER TABLE "settlement" DROP COLUMN IF EXISTS "acting_organization_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016120000_settlement_acting_organization';

COMMIT;
