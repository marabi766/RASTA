BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE asset_usage_meter IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_full_run IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_full_run WHERE run_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM asset_usage_meter WHERE meter_source = 'LEDGER') THEN
    RAISE EXCEPTION 'ACTIVE_METER_MODE_ROLLBACK_REFUSED';
  END IF;
END $$;
-- Restore the exact prerequisite definition only while the mode fence is inactive.
CREATE OR REPLACE FUNCTION usage_meter_mode_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meter_source IS DISTINCT FROM OLD.meter_source AND NOT
    (OLD.meter_source = 'LEGACY' AND NEW.meter_source = 'LEDGER') THEN
    RAISE EXCEPTION 'USAGE_METER_MODE_REGRESSION';
  END IF;
  RETURN NEW;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114090000_usage_meter_mode_search_path';
COMMIT;
