BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal, meter_drift_capacity, meter_drift_overflow IN ACCESS EXCLUSIVE MODE;
-- Diagnose incompatible retained evidence before changing either table.
DO $$
DECLARE offending_rows TEXT;
BEGIN
  SELECT string_agg(event_id, ', ' ORDER BY event_id) INTO offending_rows
  FROM meter_drift_overflow
  WHERE reason = 'SOURCE_DRIFT_HOLD'
    AND run_id NOT IN ('SOURCE_REFUSAL_UNCONFIRMED','SOURCE_INFRASTRUCTURE_DURING_REFUSAL')
    AND NOT CASE
      WHEN run_id ~ '^HOLD:(SOURCE_REFUSAL_UNCONFIRMED|SOURCE_INFRASTRUCTURE_DURING_REFUSAL):(0|[1-9][0-9]{0,18})$'
      THEN split_part(run_id, ':', 3)::numeric <= 9223372036854775807 ELSE false END;
  IF offending_rows IS NOT NULL THEN
    RAISE EXCEPTION 'METER_HOLD_NAMESPACE_PREFLIGHT_REFUSED'
      USING DETAIL = 'meter_drift_overflow event_id rows: ' || offending_rows,
        HINT = 'Inspect named rows and reconcile against audited source evidence before retrying; never guess or discard a cause.';
  END IF;
  IF EXISTS (SELECT 1 FROM meter_inventory_seal WHERE run_id IS NOT NULL
    AND run_id !~ '^[A-Za-z0-9_-]{1,64}$') THEN
    RAISE EXCEPTION 'METER_SEAL_NAMESPACE_PREFLIGHT_REFUSED'
      USING DETAIL = 'meter_inventory_seal row id=true has an invalid run_id.',
        HINT = 'Investigate the sealed inventory and reconcile against audited source evidence before retrying; do not rename an immutable seal blindly.';
  END IF;
END $$;
ALTER TABLE meter_inventory_seal ADD CONSTRAINT meter_seal_run_namespace
  CHECK (run_id IS NULL OR run_id ~ '^[A-Za-z0-9_-]{1,64}$');
-- Preserve the known first cause; pre-migration later causes cannot be reconstructed.
ALTER TABLE meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard;
UPDATE meter_drift_overflow SET run_id = 'HOLD:' || run_id || ':0' WHERE reason = 'SOURCE_DRIFT_HOLD'
  AND run_id IN ('SOURCE_REFUSAL_UNCONFIRMED','SOURCE_INFRASTRUCTURE_DURING_REFUSAL');
ALTER TABLE meter_drift_overflow ENABLE TRIGGER meter_drift_overflow_guard;
ALTER TABLE meter_drift_overflow ADD CONSTRAINT meter_hold_cause_namespace CHECK (
  reason <> 'SOURCE_DRIFT_HOLD' OR
  (CASE WHEN run_id ~ '^HOLD:(SOURCE_REFUSAL_UNCONFIRMED|SOURCE_INFRASTRUCTURE_DURING_REFUSAL):(0|[1-9][0-9]{0,18})$'
    THEN split_part(run_id, ':', 3)::numeric <= 9223372036854775807 ELSE false END));
CREATE OR REPLACE FUNCTION meter_drift_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; activation_hold UUID; previous_hold TEXT;
BEGIN
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF TG_TABLE_NAME = 'meter_drift_overflow' THEN
    IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 2 AND OLD.reason = 'SOURCE_DRIFT_HOLD'
      AND (to_jsonb(NEW) - 'run_id') = (to_jsonb(OLD) - 'run_id')
      AND split_part(NEW.run_id, ':', 2) = split_part(OLD.run_id, ':', 2)
      AND (CASE WHEN NEW.run_id ~ '^HOLD:(SOURCE_REFUSAL_UNCONFIRMED|SOURCE_INFRASTRUCTURE_DURING_REFUSAL):(0|[1-9][0-9]{0,18})$'
        AND OLD.run_id ~ '^HOLD:(SOURCE_REFUSAL_UNCONFIRMED|SOURCE_INFRASTRUCTURE_DURING_REFUSAL):(0|[1-9][0-9]{0,18})$'
        THEN split_part(NEW.run_id, ':', 3)::numeric <= 9223372036854775807
          AND split_part(NEW.run_id, ':', 3)::numeric = split_part(OLD.run_id, ':', 3)::numeric + 1
        ELSE false END) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND pg_trigger_depth() = 1 AND NEW.reason = 'SOURCE_DRIFT_HOLD' THEN
      PERFORM 1 FROM meter_drift_capacity WHERE id = true FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DRIFT_CAPACITY_MISSING'; END IF;
      IF NEW.run_id !~ '^HOLD:(SOURCE_REFUSAL_UNCONFIRMED|SOURCE_INFRASTRUCTURE_DURING_REFUSAL):0$' THEN
        RAISE EXCEPTION 'SOURCE_HOLD_CAUSE_INVALID';
      END IF;
      SELECT run_id INTO previous_hold FROM meter_drift_overflow WHERE event_id = NEW.event_id AND reason = 'SOURCE_DRIFT_HOLD';
      IF FOUND THEN
        UPDATE meter_drift_overflow SET run_id = 'HOLD:' || split_part(previous_hold, ':', 2) || ':' ||
          (split_part(previous_hold, ':', 3)::bigint + 1)::text WHERE event_id = NEW.event_id;
        RETURN NULL;
      END IF;
      IF EXISTS(SELECT 1 FROM meter_drift_overflow WHERE event_id = NEW.event_id) THEN
        RAISE EXCEPTION 'SOURCE_DRIFT_EVENT_CONFLICT';
      END IF;
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
  IF (SELECT count(*) FROM meter_drift_quarantine) >= 10000 THEN
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
