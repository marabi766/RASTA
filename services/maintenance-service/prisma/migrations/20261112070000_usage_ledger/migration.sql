-- ADR-073 § 4 D / § 4.1. Existing meters remain LEGACY until verified reconciliation.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE asset_usage_meter
  ADD COLUMN meter_source TEXT NOT NULL DEFAULT 'LEGACY',
  ADD CONSTRAINT ck_usage_meter_source CHECK (meter_source IN ('LEGACY', 'LEDGER')),
  ALTER COLUMN hour_meter TYPE NUMERIC(20,2),
  ALTER COLUMN odometer TYPE NUMERIC(20,2),
  DROP COLUMN IF EXISTS hour_meter_reading_end,
  DROP COLUMN IF EXISTS odometer_reading_end;
ALTER TABLE maintenance_schedule
  ALTER COLUMN last_serviced_hour_meter TYPE NUMERIC(20,2),
  ALTER COLUMN last_serviced_odometer TYPE NUMERIC(20,2);
CREATE TABLE asset_usage_entry (
  usage_record_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  -- Historical LEGACY events can lack an interval. Such entries cannot prove cutover.
  period_start TIMESTAMP(3),
  period_end TIMESTAMP(3),
  hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  kilometres NUMERIC(12,2) NOT NULL DEFAULT 0,
  hour_meter NUMERIC(12,2),
  odometer NUMERIC(12,2),
  CONSTRAINT ck_usage_entry_non_negative CHECK (
    hours >= 0 AND kilometres >= 0 AND
    (hour_meter IS NULL OR hour_meter >= 0) AND (odometer IS NULL OR odometer >= 0)
  ),
  CONSTRAINT ck_usage_entry_interval CHECK (period_end > period_start)
);
CREATE INDEX asset_usage_entry_asset_id_period_end_idx ON asset_usage_entry(asset_id, period_end);
CREATE INDEX asset_usage_entry_organization_id_idx ON asset_usage_entry(organization_id);
COMMIT;
