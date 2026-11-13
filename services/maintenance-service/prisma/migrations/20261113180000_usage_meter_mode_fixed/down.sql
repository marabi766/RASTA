BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE asset_usage_meter IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_full_run IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_full_run WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ACTIVE_METER_FULL_RUN_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TRIGGER usage_meter_mode_fixed ON asset_usage_meter;
DROP FUNCTION usage_meter_mode_fixed();
-- Restore the exact prerequisite function, including its unpinned lookup.
CREATE OR REPLACE FUNCTION set_usage_meter_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_run TEXT;
BEGIN
  SELECT run_id INTO active_run FROM meter_full_run WHERE id = true FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULL_RUN_GATE_MISSING';
  END IF;
  NEW.meter_source := CASE WHEN active_run IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meter_full_run_asset WHERE asset_id = NEW.asset_id AND outcome = 'REFUSED'
  ) THEN 'LEDGER' ELSE 'LEGACY' END;
  RETURN NEW;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113180000_usage_meter_mode_fixed';
COMMIT;
