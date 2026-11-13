BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION set_usage_meter_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE active_run TEXT;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  SELECT run_id INTO active_run FROM meter_full_run WHERE id = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FULL_RUN_GATE_MISSING'; END IF;
  NEW.meter_source := CASE WHEN active_run IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meter_full_run_asset WHERE asset_id = NEW.asset_id AND outcome = 'REFUSED'
  ) THEN 'LEDGER' ELSE 'LEGACY' END;
  RETURN NEW;
END $$;
CREATE FUNCTION usage_meter_mode_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meter_source IS DISTINCT FROM OLD.meter_source AND NOT
    (OLD.meter_source = 'LEGACY' AND NEW.meter_source = 'LEDGER') THEN
    RAISE EXCEPTION 'USAGE_METER_MODE_REGRESSION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_meter_mode_fixed BEFORE UPDATE OF meter_source ON asset_usage_meter
  FOR EACH ROW EXECUTE FUNCTION usage_meter_mode_fixed();
COMMIT;
