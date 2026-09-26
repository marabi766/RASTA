-- Reverses 20260925110000_asset_legacy_dossier_and_identifiers.
--
-- Roll back 20260926000000 and 20260925120000 first (the harness runs downs
-- newest first). The latter's down restores the composite indexes, under which
-- the original spellings do not collide.
--
-- Restores every value the migration changed from asset_legacy_migration_log:
-- identifiers get their original spelling back, and dossier rows go back to
-- the organization they were under. That is the exact pre-migration state,
-- including the split dossier and its stuck claims, which is what a rollback
-- of this migration means.
--
-- But only if nothing has happened since (PR #108 round 2 #3). A logged column
-- that no longer holds the value the migration wrote was changed by the
-- business afterwards: a later transfer moved the row, or a user corrected an
-- identifier. Restoring over it would discard that change and could split a
-- dossier the transfer had just made whole. The same goes for any asset with
-- logged rows that has been transferred since. In either case the rollback is
-- refused before anything is changed, and the rows are listed.
--
-- Locks the same tables in the same order as the migration, so nothing moves
-- between the check and the restore. Atomic, like the migration.

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE
  "asset",
  "asset_timeline_entry",
  "asset_location",
  "asset_document_ref",
  "insurance_policy",
  "insurance_claim",
  "technical_inspection",
  "asset_transfer",
  "asset_legacy_migration_log"
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  target record;
  conflicts text[] := '{}';
  found text[];
BEGIN
  -- A logged column that no longer holds what the migration wrote.
  FOR target IN
    SELECT DISTINCT table_name, column_name FROM asset_legacy_migration_log
  LOOP
    EXECUTE format(
      'SELECT array_agg(format(''%%s.%%s row %%s: now %%s, migration wrote %%s'',
                                l.table_name, l.column_name, l.row_id,
                                coalesce(t.%I::text, ''NULL''), coalesce(l.new_value, ''NULL'')))
         FROM asset_legacy_migration_log l
         JOIN %I t ON t.id = l.row_id
        WHERE l.table_name = %L AND l.column_name = %L
          AND t.%I::text IS DISTINCT FROM l.new_value',
      target.column_name, target.table_name, target.table_name, target.column_name,
      target.column_name)
      INTO found;
    conflicts := conflicts || coalesce(found, '{}');
  END LOOP;

  -- An asset with logged rows that changed hands after the migration.
  SELECT array_agg(DISTINCT format('asset %s: transferred at %s, after the migration',
                                   t.asset_id, t.transferred_at))
    INTO found
    FROM asset_transfer t
    JOIN asset_legacy_migration_log l ON l.asset_id = t.asset_id
   WHERE t.transferred_at > l.logged_at;
  conflicts := conflicts || coalesce(found, '{}');

  IF cardinality(conflicts) > 0 THEN
    RAISE EXCEPTION 'asset_legacy_migration_log: % row(s) changed after the migration; nothing was rolled back. First 20: %',
        cardinality(conflicts), array_to_string(conflicts[1:20], '; ')
      USING HINT ='Restoring them would overwrite later business changes. Decide per row with an operator; do not force this rollback.';
  END IF;
END
$preflight$;

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
