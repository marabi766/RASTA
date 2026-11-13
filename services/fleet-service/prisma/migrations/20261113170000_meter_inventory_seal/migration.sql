BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE meter_inventory_seal (
  id BOOLEAN PRIMARY KEY CHECK (id),
  run_id TEXT,
  operator_id TEXT,
  inventory JSONB,
  boundary TEXT,
  CHECK ((run_id IS NULL AND operator_id IS NULL AND inventory IS NULL AND boundary IS NULL) OR
    (run_id IS NOT NULL AND operator_id IS NOT NULL AND jsonb_typeof(inventory) = 'array'
      AND inventory IS NOT NULL AND boundary IS NOT NULL))
);
INSERT INTO meter_inventory_seal(id) VALUES (true);

-- Permanent, schema-local gate. Never expire a fence while a remote commit may be in flight.
CREATE FUNCTION meter_inventory_creation_fence() RETURNS trigger
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
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON asset_ref
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON usage_record
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON assignment
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON availability_window
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON asset_transfer_fence
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON asset_transfer_release
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');
CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE ON insurance_pending_verification
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_creation_fence('asset_id');

CREATE FUNCTION meter_inventory_seal_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  IF OLD.run_id IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_SEAL_FIXED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meter_inventory_seal_fixed BEFORE UPDATE OR DELETE ON meter_inventory_seal
  FOR EACH ROW EXECUTE FUNCTION meter_inventory_seal_fixed();
CREATE TRIGGER meter_inventory_seal_no_truncate BEFORE TRUNCATE ON meter_inventory_seal
  FOR EACH STATEMENT EXECUTE FUNCTION meter_inventory_seal_fixed();
COMMIT;
