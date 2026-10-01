-- =============================================================================
-- Reverse of `migration.sql` (20260930130000_policy_suspension).
--
-- A SUSPENDED policy cannot exist without the value, so each one becomes
-- RETIRED (retired when, and by whom, it was suspended). It is out of force
-- either way; what is lost is the fact that it was suspended and why. Events
-- already published have left; audit-service keeps its own copy of each.
-- =============================================================================

ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_suspension_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_activation_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_retirement_complete";

UPDATE "approval_policy"
   SET "status" = 'RETIRED', "retired_at" = "suspended_at", "retired_by" = "suspended_by"
 WHERE "status" = 'SUSPENDED';

ALTER TABLE "approval_policy"
  DROP COLUMN IF EXISTS "suspended_at",
  DROP COLUMN IF EXISTS "suspended_by",
  DROP COLUMN IF EXISTS "suspension_reason";

-- Rebuild the enum without SUSPENDED. Everything that names the column is
-- dropped first and put back as the original migration wrote it.
DROP INDEX IF EXISTS "ux_approval_policy_active";
ALTER TABLE "approval_policy" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_submission_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_rejection_complete";

ALTER TYPE "ApprovalPolicyStatus" RENAME TO "ApprovalPolicyStatus_with_suspended";
CREATE TYPE "ApprovalPolicyStatus" AS ENUM ('DRAFT', 'PENDING_PLATFORM_APPROVAL', 'ACTIVE', 'REJECTED', 'RETIRED');
ALTER TABLE "approval_policy"
  ALTER COLUMN "status" TYPE "ApprovalPolicyStatus"
  USING "status"::text::"ApprovalPolicyStatus";
ALTER TABLE "approval_policy" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "ApprovalPolicyStatus_with_suspended";

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_submission_complete"
  CHECK (num_nonnulls("submitted_at", "submitted_by") IN (0, 2)
         AND (("status" = 'DRAFT') = ("submitted_at" IS NULL)));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND (("status" IN ('ACTIVE', 'RETIRED')) = ("activated_at" IS NOT NULL))
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_rejection_complete"
  CHECK (num_nonnulls("rejected_at", "rejected_by", "rejection_reason") IN (0, 3)
         AND (("status" = 'REJECTED') = ("rejected_at" IS NOT NULL))
         AND ("rejection_reason" IS NULL OR btrim("rejection_reason") <> '')
         AND ("rejected_at" IS NULL OR "rejected_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_retirement_complete"
  CHECK (num_nonnulls("retired_at", "retired_by") IN (0, 2)
         AND (("status" = 'RETIRED') = ("retired_at" IS NOT NULL))
         AND ("retired_at" IS NULL OR "retired_at" >= "activated_at"));

CREATE UNIQUE INDEX "ux_approval_policy_active"
    ON "approval_policy" ("organization_id", "workflow_key")
 WHERE "status" = 'ACTIVE';

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930130000_policy_suspension';
