BEGIN;
SET LOCAL lock_timeout = '5s';
-- All writers (including older images, model API seeds and explicit modes) use
-- the same first-meter decision. ON CONFLICT also runs this BEFORE trigger.
CREATE FUNCTION set_usage_meter_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_run TEXT;
BEGIN
  SELECT run_id INTO active_run FROM meter_full_run WHERE id = true FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULL_RUN_GATE_MISSING';
  END IF;
  NEW.meter_source := CASE WHEN active_run IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meter_full_run_asset WHERE asset_id = NEW.asset_id AND outcome = 'REFUSED'
  ) THEN 'LEDGER' ELSE 'LEGACY' END;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_meter_insert_fence BEFORE INSERT ON asset_usage_meter
  FOR EACH ROW EXECUTE FUNCTION set_usage_meter_source();
ALTER TABLE asset_usage_meter ALTER COLUMN meter_source DROP DEFAULT;
COMMIT;
