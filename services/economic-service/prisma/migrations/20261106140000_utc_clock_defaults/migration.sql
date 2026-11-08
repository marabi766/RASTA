-- FU-188: these `timestamp(3)` columns are written from their DEFAULT by raw SQL (a raw INSERT
-- or a function of ours) or are deadlines. `CURRENT_TIMESTAMP` stores the SESSION's wall time
-- there, so a session outside UTC would write them off by its offset. Every other reader
-- takes them as UTC wall time. No rewrite, no row changes: only the default expression.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "transaction_hold_decision" ALTER COLUMN "decided_at" SET DEFAULT timezone('UTC', now());
ALTER TABLE "transaction_source_quarantine" ALTER COLUMN "quarantined_at" SET DEFAULT timezone('UTC', now());

-- The same class in a trigger: `held_at` is timestamp(3), so its stamp is UTC wall time too.
CREATE OR REPLACE FUNCTION stamp_transaction_held_at() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."held_at" IS NOT NULL THEN
    NEW."held_at" := OLD."held_at";
  ELSIF NEW."status" = 'HELD' THEN
    NEW."held_at" := now() AT TIME ZONE 'UTC';
  ELSE
    NEW."held_at" := NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
