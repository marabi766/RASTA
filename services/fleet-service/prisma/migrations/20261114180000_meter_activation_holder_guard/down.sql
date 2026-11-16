BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal, meter_drift_capacity IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed'
    OR NOT EXISTS (SELECT 1 FROM meter_drift_capacity WHERE id = true AND overflow_count = 0 AND activation_token IS NULL)
    OR EXISTS (SELECT 1 FROM meter_drift_quarantine) OR EXISTS (SELECT 1 FROM meter_drift_overflow) THEN
    RAISE EXCEPTION 'ACTIVE_DRIFT_EVIDENCE_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TRIGGER meter_activation_holder_guard ON meter_drift_capacity;
DROP FUNCTION meter_activation_holder_guard();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114180000_meter_activation_holder_guard';
COMMIT;
