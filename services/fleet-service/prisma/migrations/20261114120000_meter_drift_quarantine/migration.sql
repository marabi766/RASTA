BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
CREATE TABLE meter_drift_capacity (id BOOLEAN PRIMARY KEY CHECK(id), activation_token UUID);
INSERT INTO meter_drift_capacity(id) VALUES (true);
-- Platform-only evidence. No tenant API, resolution or expiry in this slice.
CREATE TABLE meter_drift_quarantine (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  sealed_owner TEXT,
  named_owner TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('SOURCE_OWNER_DRIFT', 'SOURCE_INVENTORY_SEALED')),
  run_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT source_drift_evidence_size CHECK (
    octet_length(event_id) BETWEEN 1 AND 256 AND octet_length(asset_id) BETWEEN 1 AND 256
    AND octet_length(named_owner) BETWEEN 1 AND 256 AND octet_length(run_id) BETWEEN 1 AND 256
    AND (sealed_owner IS NULL OR octet_length(sealed_owner) BETWEEN 1 AND 256))
);
CREATE INDEX meter_drift_quarantine_run ON meter_drift_quarantine(run_id);
CREATE FUNCTION meter_drift_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; activation_hold UUID;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SOURCE_DRIFT_QUARANTINE_FIXED'; END IF;
  SELECT run_id INTO sealed_run FROM meter_inventory_seal WHERE id = true FOR SHARE;
  IF NOT FOUND OR sealed_run IS NULL OR sealed_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_RUN_INVALID';
  END IF;
  SELECT activation_token INTO activation_hold FROM meter_drift_capacity WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_MISSING'; END IF;
  IF EXISTS (SELECT 1 FROM meter_drift_quarantine WHERE event_id = NEW.event_id) THEN
    IF NOT EXISTS (SELECT 1 FROM meter_drift_quarantine q WHERE q.event_id = NEW.event_id
      AND q.asset_id = NEW.asset_id AND q.sealed_owner IS NOT DISTINCT FROM NEW.sealed_owner
      AND q.named_owner = NEW.named_owner AND q.reason = NEW.reason AND q.run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'SOURCE_DRIFT_EVENT_CONFLICT';
    END IF;
    RETURN NULL;
  END IF;
  IF activation_hold IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_ACTIVATION_HELD'; END IF;
  -- Global durable cap, checked after replay under the capacity lock. Never evict.
  IF (SELECT count(*) FROM meter_drift_quarantine) >= 10000 THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_QUARANTINE_FULL';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meter_drift_quarantine_guard BEFORE INSERT OR UPDATE OR DELETE ON meter_drift_quarantine
  FOR EACH ROW EXECUTE FUNCTION meter_drift_quarantine_guard();
CREATE TRIGGER meter_drift_quarantine_no_truncate BEFORE TRUNCATE ON meter_drift_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION meter_drift_quarantine_guard();
COMMIT;
