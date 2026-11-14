BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal, meter_drift_capacity IN ACCESS EXCLUSIVE MODE;
-- Holder capability is transaction-local, never inferred from a caller's WHERE.
-- Unchanged tokens still permit evidence increments. Token transitions cannot
-- alter the overflow latch or replace another holder's token.
CREATE FUNCTION meter_activation_holder_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.activation_token IS NOT DISTINCT FROM OLD.activation_token THEN RETURN NEW; END IF;
  IF NEW.overflow_count = OLD.overflow_count AND (
    (OLD.activation_token IS NULL AND NEW.activation_token IS NOT NULL
      AND current_setting('rasta.meter_activation_token', true) = NEW.activation_token::text)
    OR (NEW.activation_token IS NULL AND OLD.activation_token IS NOT NULL
      AND current_setting('rasta.meter_activation_token', true) = OLD.activation_token::text)
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SOURCE_ACTIVATION_HOLDER_REQUIRED';
END $$;
CREATE TRIGGER meter_activation_holder_guard BEFORE UPDATE ON meter_drift_capacity
  FOR EACH ROW EXECUTE FUNCTION meter_activation_holder_guard();
COMMIT;
