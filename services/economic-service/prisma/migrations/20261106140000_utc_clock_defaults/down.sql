-- Restores the session-dependent defaults of 20261106140000_utc_clock_defaults.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "transaction_hold_decision" ALTER COLUMN "decided_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "transaction_source_quarantine" ALTER COLUMN "quarantined_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION stamp_transaction_held_at() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."held_at" IS NOT NULL THEN
    NEW."held_at" := OLD."held_at";
  ELSIF NEW."status" = 'HELD' THEN
    NEW."held_at" := CURRENT_TIMESTAMP;
  ELSE
    NEW."held_at" := NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106140000_utc_clock_defaults';
