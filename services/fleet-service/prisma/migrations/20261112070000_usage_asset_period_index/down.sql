BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX usage_record_asset_id_period_end_id_idx;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112070000_usage_asset_period_index';
COMMIT;
