BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE NOWAIT;
-- An old active seal may already contain owner drift; never certify it by backfill.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SOURCE_SEAL_UPGRADE_REFUSED';
  END IF;
END $$;
CREATE TABLE meter_inventory_seal_asset (
  asset_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL
);
CREATE FUNCTION meter_inventory_seal_asset_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  SELECT run_id INTO sealed_run FROM meter_inventory_seal WHERE id = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FENCE_MISSING'; END IF;
  IF sealed_run IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meter_inventory_seal_asset_fixed BEFORE INSERT OR UPDATE OR DELETE
  ON meter_inventory_seal_asset FOR EACH ROW EXECUTE FUNCTION meter_inventory_seal_asset_fixed();
CREATE TRIGGER meter_inventory_seal_asset_no_truncate BEFORE TRUNCATE
  ON meter_inventory_seal_asset FOR EACH STATEMENT EXECUTE FUNCTION meter_inventory_seal_asset_fixed();
CREATE OR REPLACE FUNCTION meter_inventory_seal_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  IF OLD.run_id IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  -- Replace any pre-seal metadata atomically; only the canonical sealed pairs survive.
  DELETE FROM meter_inventory_seal_asset;
  INSERT INTO meter_inventory_seal_asset(asset_id, organization_id)
    SELECT v ->> 'assetId', v ->> 'organizationId' FROM jsonb_array_elements(NEW.inventory) v;
  RETURN NEW;
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
COMMIT;
