-- FU-339 / ADR-073 PR 9: internal maintenance paging spans asset owners.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX usage_record_asset_id_period_end_id_idx ON usage_record(asset_id, period_end, id);
COMMIT;
