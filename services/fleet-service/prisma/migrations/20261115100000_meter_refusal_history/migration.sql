BEGIN;
SET LOCAL lock_timeout = '5s';
-- Global hash-only history, independent of the seal and parked-row fences.
CREATE TABLE meter_refusal_history (event_hash TEXT PRIMARY KEY CHECK (event_hash ~ '^[0-9a-f]{64}$'));
CREATE FUNCTION meter_refusal_history_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'SOURCE_REFUSAL_HISTORY_FIXED';
END $$;
CREATE TRIGGER meter_refusal_history_fixed BEFORE UPDATE OR DELETE ON meter_refusal_history
  FOR EACH ROW EXECUTE FUNCTION meter_refusal_history_fixed();
CREATE TRIGGER meter_refusal_history_no_truncate BEFORE TRUNCATE ON meter_refusal_history
  FOR EACH STATEMENT EXECUTE FUNCTION meter_refusal_history_fixed();
COMMIT;
