BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_drift_overflow IN ACCESS EXCLUSIVE MODE;
ALTER TABLE meter_drift_overflow DROP CONSTRAINT meter_drift_overflow_reason_check;
ALTER TABLE meter_drift_overflow ADD CONSTRAINT meter_drift_overflow_reason_check CHECK (reason IN ('SOURCE_OWNER_DRIFT', 'SOURCE_INVENTORY_SEALED', 'SOURCE_DRIFT_HOLD'));
CREATE OR REPLACE FUNCTION meter_drift_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; activation_hold UUID;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF TG_TABLE_NAME = 'meter_drift_overflow' THEN
    -- Direct platform holds bypass the broken seal, but share the bounded overflow latch.
    IF TG_OP = 'INSERT' AND pg_trigger_depth() = 1 AND NEW.reason = 'SOURCE_DRIFT_HOLD' THEN
      PERFORM 1 FROM meter_drift_capacity WHERE id = true FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_MISSING'; END IF;
      IF EXISTS(SELECT 1 FROM meter_drift_overflow WHERE event_id = NEW.event_id) THEN RETURN NULL; END IF;
      DELETE FROM meter_drift_overflow WHERE event_id IN
        (SELECT event_id FROM meter_drift_overflow ORDER BY first_seen_at, event_id
          LIMIT greatest(0, (SELECT count(*) FROM meter_drift_overflow) - 9999));
      UPDATE meter_drift_capacity SET overflow_count =
        CASE WHEN overflow_count < 9223372036854775807 THEN overflow_count + 1 ELSE overflow_count END WHERE id = true;
      RETURN NEW;
    END IF;
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
COMMIT;
