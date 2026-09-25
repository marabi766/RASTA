-- Reverses 20260925110000_asset_legacy_dossier_and_identifiers.
--
-- Roll back 20260925120000 first (the harness runs downs newest first). Its
-- down restores the composite indexes, under which the original spellings do
-- not collide.
--
-- Restores every value the migration changed from asset_legacy_migration_log:
-- identifiers get their original spelling back, and dossier rows go back to
-- the organization they were under. That is the exact pre-migration state,
-- including the split dossier and its stuck claims, which is what a rollback
-- of this migration means. A row a later transfer moved again is put back
-- where the migration found it.
--
-- Atomic, like the migration.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $restore$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT DISTINCT table_name, column_name FROM asset_legacy_migration_log
  LOOP
    EXECUTE format(
      'UPDATE %I t SET %I = l.old_value
         FROM asset_legacy_migration_log l
        WHERE l.table_name = %L AND l.column_name = %L AND l.row_id = t.id',
      target.table_name, target.column_name, target.table_name, target.column_name);
  END LOOP;
END
$restore$;

DROP TABLE IF EXISTS "asset_legacy_migration_log";
DROP FUNCTION IF EXISTS canonical_identifier(text);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925110000_asset_legacy_dossier_and_identifiers';

COMMIT;
