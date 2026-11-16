BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION usage_meter_mode_fixed() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.meter_source IS DISTINCT FROM OLD.meter_source AND NOT
    (OLD.meter_source = 'LEGACY' AND NEW.meter_source = 'LEDGER') THEN
    RAISE EXCEPTION 'USAGE_METER_MODE_REGRESSION';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
