BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SEALED_SOURCE_ROLLBACK_REFUSED';
  END IF;
END $$;
-- Restore both prerequisite functions verbatim (apart from CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION meter_inventory_creation_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed JSONB;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_FENCE_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  SELECT inventory INTO sealed FROM meter_inventory_seal WHERE id = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FENCE_MISSING'; END IF;
  IF sealed IS NOT NULL AND NOT sealed @> jsonb_build_array(
    jsonb_build_object('assetId', to_jsonb(NEW) ->> TG_ARGV[0])) THEN
    RAISE EXCEPTION 'SOURCE_INVENTORY_SEALED';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION meter_inventory_seal_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  IF OLD.run_id IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  RETURN NEW;
END $$;
DROP TABLE meter_inventory_seal_asset;
DROP FUNCTION meter_inventory_seal_asset_fixed();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113220000_meter_inventory_owner_fence';
COMMIT;
