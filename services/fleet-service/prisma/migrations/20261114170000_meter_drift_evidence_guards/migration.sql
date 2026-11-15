BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
CREATE FUNCTION meter_drift_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior RECORD;
BEGIN
  IF TG_TABLE_NAME = 'meter_drift_capacity' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.overflow_count >= OLD.overflow_count THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_FIXED';
  END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM 1 FROM meter_inventory_seal WHERE id = true FOR SHARE;
  PERFORM 1 FROM meter_drift_capacity WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_MISSING'; END IF;
  SELECT * INTO prior FROM
    (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) q
    WHERE event_id = NEW.event_id;
  IF FOUND THEN
    IF prior.asset_id IS DISTINCT FROM NEW.asset_id OR prior.reason IS DISTINCT FROM NEW.reason OR prior.run_id IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'SOURCE_DRIFT_EVENT_CONFLICT';
    END IF;
    NEW.named_owner := prior.named_owner;
    NEW.sealed_owner := prior.sealed_owner;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meter_drift_capacity_guard BEFORE UPDATE OR DELETE ON meter_drift_capacity
  FOR EACH ROW EXECUTE FUNCTION meter_drift_evidence_guard();
CREATE TRIGGER meter_drift_capacity_no_truncate BEFORE TRUNCATE ON meter_drift_capacity
  FOR EACH STATEMENT EXECUTE FUNCTION meter_drift_evidence_guard();
-- PostgreSQL runs BEFORE triggers alphabetically: canonicalize before quarantine_guard.
CREATE TRIGGER meter_drift_evidence_identity BEFORE INSERT ON meter_drift_quarantine
  FOR EACH ROW EXECUTE FUNCTION meter_drift_evidence_guard();
COMMIT;
