BEGIN;
SET LOCAL lock_timeout = '5s';
-- INSERT takes the meter table before the gate; activation takes the gate
-- before reading meters. Refuse an overlapping activation without a wait cycle.
LOCK TABLE asset_usage_meter IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_full_run IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_full_run WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ACTIVE_METER_FULL_RUN_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TRIGGER usage_meter_insert_fence ON asset_usage_meter;
DROP FUNCTION set_usage_meter_source();
ALTER TABLE asset_usage_meter ALTER COLUMN meter_source SET DEFAULT 'LEGACY';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113160000_usage_meter_insert_fence';
COMMIT;
