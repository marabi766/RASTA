-- Refuse to erase reference evidence (ADR-071 § 7). Lock before checking so
-- an insert cannot race the check. The file runner applies this atomically.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "baseline_metric" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "baseline_metric") THEN
    RAISE EXCEPTION 'baseline_metric contains reference evidence; rollback refused';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "tg_baseline_metric_recorded_at" ON "baseline_metric";
DROP TRIGGER IF EXISTS "tg_baseline_metric_no_truncate" ON "baseline_metric";
DROP TRIGGER IF EXISTS "tg_baseline_metric_append_only" ON "baseline_metric";
DROP FUNCTION IF EXISTS "baseline_metric_append_only"();
DROP TABLE IF EXISTS "baseline_metric";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024120000_baseline_metric';
