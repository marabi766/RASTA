-- Refuse an unsafe narrowing; never truncate a meter or an anchor on rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE asset_usage_meter, maintenance_schedule, asset_usage_entry IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM asset_usage_meter WHERE hour_meter > 9999999999.99 OR odometer > 9999999999.99)
    OR EXISTS (SELECT 1 FROM maintenance_schedule WHERE last_serviced_hour_meter > 9999999999.99 OR last_serviced_odometer > 9999999999.99)
  THEN RAISE EXCEPTION 'usage ledger rollback requires meters and anchors within NUMERIC(12,2)';
  END IF;
END $$;
ALTER TABLE maintenance_schedule
  ALTER COLUMN last_serviced_hour_meter TYPE NUMERIC(12,2),
  ALTER COLUMN last_serviced_odometer TYPE NUMERIC(12,2);
ALTER TABLE asset_usage_meter
  ALTER COLUMN hour_meter TYPE NUMERIC(12,2),
  ALTER COLUMN odometer TYPE NUMERIC(12,2),
  DROP CONSTRAINT ck_usage_meter_source,
  DROP COLUMN meter_source;
DROP TABLE asset_usage_entry;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112070000_usage_ledger';
COMMIT;
