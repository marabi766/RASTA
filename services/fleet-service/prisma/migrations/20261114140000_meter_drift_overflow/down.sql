BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE meter_inventory_seal IN ACCESS EXCLUSIVE MODE;
LOCK TABLE meter_drift_capacity IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DRIFT_REQUIRES_READ_COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM meter_drift_capacity WHERE id = true AND overflow_count = 0 AND activation_token IS NULL)
    OR EXISTS (SELECT 1 FROM meter_drift_overflow) THEN
    RAISE EXCEPTION 'ACTIVE_DRIFT_OVERFLOW_ROLLBACK_REFUSED';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION meter_inventory_creation_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_run TEXT; sealed_owner TEXT;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_FENCE_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
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
DROP TABLE meter_drift_overflow;
ALTER TABLE meter_drift_capacity DROP COLUMN overflow_count;
CREATE OR REPLACE FUNCTION meter_drift_quarantine_guard() RETURNS trigger
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
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114140000_meter_drift_overflow';
COMMIT;
