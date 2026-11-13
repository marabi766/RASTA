BEGIN;
SET LOCAL lock_timeout = '5s';
-- Permanent shared/exclusive fence: first-meter creation versus activation.
CREATE TABLE meter_full_run (
  id BOOLEAN PRIMARY KEY CHECK (id),
  run_id TEXT UNIQUE,
  operator_id TEXT,
  inventory_digest TEXT,
  source_boundary TEXT,
  activated_at TIMESTAMP(3),
  CHECK ((run_id IS NULL AND operator_id IS NULL AND inventory_digest IS NULL
    AND source_boundary IS NULL AND activated_at IS NULL) OR
    (run_id IS NOT NULL AND operator_id IS NOT NULL AND inventory_digest IS NOT NULL
    AND source_boundary IS NOT NULL AND activated_at IS NOT NULL))
);
INSERT INTO meter_full_run(id) VALUES (true);
CREATE TABLE meter_full_run_asset (
  asset_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('LEDGER', 'REFUSED')),
  refusal TEXT,
  CHECK ((outcome = 'REFUSED') = (refusal IS NOT NULL))
);
CREATE INDEX meter_full_run_asset_organization_id_idx ON meter_full_run_asset(organization_id);
COMMIT;
