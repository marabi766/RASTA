-- Destructive rollback: reference measurements cannot be reconstructed from Kafka.
-- Run only as the migrator; removes this migration's objects, preserving PR 1's facts.
DROP TRIGGER IF EXISTS "tg_baseline_metric_recorded_at" ON "baseline_metric";
DROP TRIGGER IF EXISTS "tg_baseline_metric_no_truncate" ON "baseline_metric";
DROP TRIGGER IF EXISTS "tg_baseline_metric_append_only" ON "baseline_metric";
DROP FUNCTION IF EXISTS "baseline_metric_append_only"();
DROP TABLE IF EXISTS "baseline_metric";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024120000_baseline_metric';
