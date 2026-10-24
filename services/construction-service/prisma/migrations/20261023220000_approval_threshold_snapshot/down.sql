DROP TRIGGER tg_approval_threshold_snapshot ON "tender_approval_request";
DROP FUNCTION guard_approval_threshold_snapshot();
ALTER TABLE "tender_approval_request"
  DROP CONSTRAINT "ck_tender_approval_threshold_snapshot",
  DROP COLUMN "procurement_threshold_warning",
  DROP COLUMN "procurement_threshold_policy_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023220000_approval_threshold_snapshot';
