BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SEALED_SOURCE_ROLLBACK_REFUSED';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION meter_inventory_creation_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; sealed_owner TEXT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_FENCE_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  -- Read the small gate field only; no inventory detoast/linear scan on source writes.
  SELECT run_id INTO sealed_run FROM meter_inventory_seal WHERE id = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FENCE_MISSING'; END IF;
  IF sealed_run IS NOT NULL THEN
    SELECT organization_id INTO sealed_owner FROM meter_inventory_seal_asset
      WHERE asset_id = to_jsonb(NEW) ->> TG_ARGV[0];
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_INVENTORY_SEALED'; END IF;
    IF sealed_owner IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'SOURCE_OWNER_DRIFT';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114100000_meter_inventory_identity_update';
COMMIT;
