BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE asset_ref, usage_record, assignment, availability_window,
  asset_transfer_fence, asset_transfer_release, insurance_pending_verification IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SEALED_SOURCE_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP TRIGGER meter_inventory_creation_fence ON asset_ref;
DROP TRIGGER meter_inventory_creation_fence ON usage_record;
DROP TRIGGER meter_inventory_creation_fence ON assignment;
DROP TRIGGER meter_inventory_creation_fence ON availability_window;
DROP TRIGGER meter_inventory_creation_fence ON asset_transfer_fence;
DROP TRIGGER meter_inventory_creation_fence ON asset_transfer_release;
DROP TRIGGER meter_inventory_creation_fence ON insurance_pending_verification;
DROP TABLE meter_inventory_seal;
DROP FUNCTION meter_inventory_creation_fence();
DROP FUNCTION meter_inventory_seal_fixed();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113170000_meter_inventory_seal';
COMMIT;
