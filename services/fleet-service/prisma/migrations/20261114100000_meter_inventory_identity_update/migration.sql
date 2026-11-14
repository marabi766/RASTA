BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
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
  -- Historical rows cannot alter the sealed inventory while both identity fields stay fixed.
  -- Still lock/read the gate above: missing gates and stale isolation must always refuse.
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) ->> TG_ARGV[0]) IS NOT DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0])
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
      RETURN NEW;
    END IF;
  END IF;
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
