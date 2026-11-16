BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
ALTER TABLE meter_drift_capacity ADD COLUMN overflow_count BIGINT NOT NULL DEFAULT 0 CHECK (overflow_count >= 0);
-- Same bounded fields; no tenant model or API. At most 10,000 recent overflow events.
CREATE TABLE meter_drift_overflow (
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
CREATE INDEX meter_drift_overflow_oldest ON meter_drift_overflow(first_seen_at, event_id);
CREATE OR REPLACE FUNCTION meter_drift_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; activation_hold UUID;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF TG_TABLE_NAME = 'meter_drift_overflow' THEN
    IF pg_trigger_depth() <> 2 OR TG_OP NOT IN ('INSERT', 'DELETE') THEN
      RAISE EXCEPTION 'SOURCE_DRIFT_QUARANTINE_FIXED';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SOURCE_DRIFT_QUARANTINE_FIXED'; END IF;
  SELECT run_id INTO sealed_run FROM meter_inventory_seal WHERE id = true FOR SHARE;
  IF NOT FOUND OR sealed_run IS NULL OR sealed_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_RUN_INVALID';
  END IF;
  SELECT activation_token INTO activation_hold FROM meter_drift_capacity WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_MISSING'; END IF;
  IF EXISTS (SELECT 1 FROM (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) evidence WHERE event_id = NEW.event_id) THEN
    IF NOT EXISTS (SELECT 1 FROM (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) q WHERE q.event_id = NEW.event_id
      AND q.asset_id = NEW.asset_id AND q.sealed_owner IS NOT DISTINCT FROM NEW.sealed_owner
      AND q.named_owner = NEW.named_owner AND q.reason = NEW.reason AND q.run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'SOURCE_DRIFT_EVENT_CONFLICT';
    END IF;
    RETURN NULL;
  END IF;
  IF activation_hold IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_ACTIVATION_HELD'; END IF;
  -- Global durable cap, checked after replay under the capacity lock. Never evict.
  IF (SELECT count(*) FROM meter_drift_quarantine) >= 10000 THEN
    -- Bounded recent evidence, plus a permanent fail-closed overflow latch.
    DELETE FROM meter_drift_overflow WHERE event_id IN
      (SELECT event_id FROM meter_drift_overflow ORDER BY first_seen_at, event_id
       LIMIT greatest(0, (SELECT count(*) FROM meter_drift_overflow) - 9999));
    INSERT INTO meter_drift_overflow VALUES (NEW.*);
    UPDATE meter_drift_capacity SET overflow_count =
      CASE WHEN overflow_count < 9223372036854775807 THEN overflow_count + 1 ELSE overflow_count END
      WHERE id = true;
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meter_drift_overflow_guard BEFORE INSERT OR UPDATE OR DELETE ON meter_drift_overflow
  FOR EACH ROW EXECUTE FUNCTION meter_drift_quarantine_guard();
CREATE TRIGGER meter_drift_overflow_no_truncate BEFORE TRUNCATE ON meter_drift_overflow
  FOR EACH STATEMENT EXECUTE FUNCTION meter_drift_quarantine_guard();
CREATE OR REPLACE FUNCTION meter_inventory_creation_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; sealed_owner TEXT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_FENCE_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  -- Backoff can progress even with a missing gate. Every identity/envelope field
  -- must be byte-for-byte unchanged; this exception cannot apply source facts.
  IF TG_TABLE_NAME = 'insurance_pending_verification' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['attempts','last_attempt_at','next_attempt_at','reason'])
      IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['attempts','last_attempt_at','next_attempt_at','reason']) THEN
      RETURN NEW;
    END IF;
  END IF;
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
