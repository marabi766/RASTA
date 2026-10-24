DROP TRIGGER IF EXISTS tg_tender_procurement_estimate ON "tender";
DROP FUNCTION IF EXISTS guard_tender_procurement_estimate();
ALTER TABLE "tender"
  DROP CONSTRAINT IF EXISTS "ck_tender_threshold_warning",
  DROP CONSTRAINT IF EXISTS "ck_tender_estimate_nonnegative",
  DROP COLUMN IF EXISTS "procurement_threshold_policy_id",
  DROP COLUMN IF EXISTS "procurement_threshold_warning",
  DROP COLUMN IF EXISTS "estimated_cost_minor";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023120000_procurement_thresholds';
