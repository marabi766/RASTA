BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_drift_quarantine IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM meter_drift_quarantine)
    OR EXISTS (SELECT 1 FROM meter_drift_capacity WHERE activation_token IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM meter_inventory_seal WHERE id = true)
    OR NOT EXISTS (SELECT 1 FROM meter_drift_capacity WHERE id = true) THEN
    RAISE EXCEPTION 'ACTIVE_DRIFT_QUARANTINE_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TABLE meter_drift_quarantine, meter_drift_capacity;
DROP FUNCTION meter_drift_quarantine_guard();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114120000_meter_drift_quarantine';
COMMIT;
