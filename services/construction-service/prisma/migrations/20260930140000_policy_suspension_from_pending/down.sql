-- =============================================================================
-- Reverse of `migration.sql` (20260930140000_policy_suspension_from_pending).
--
-- A policy suspended while still pending has no platform approval, so under the
-- earlier constraint it cannot stay SUSPENDED. It becomes REJECTED, with the
-- suspension's time, actor and reason as the rejection's; what is lost is the
-- fact that it was suspended and not rejected by a person.
-- =============================================================================

ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_suspension_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_rejection_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_activation_complete";

UPDATE "approval_policy"
   SET "status" = 'REJECTED',
       "rejected_at" = "suspended_at",
       "rejected_by" = "suspended_by",
       "rejection_reason" = "suspension_reason",
       "suspended_at" = NULL,
       "suspended_by" = NULL,
       "suspension_reason" = NULL
 WHERE "status"::text = 'SUSPENDED' AND "activated_at" IS NULL;

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_rejection_complete"
  CHECK (num_nonnulls("rejected_at", "rejected_by", "rejection_reason") IN (0, 3)
         AND (("status" = 'REJECTED') = ("rejected_at" IS NOT NULL))
         AND ("rejection_reason" IS NULL OR btrim("rejection_reason") <> '')
         AND ("rejected_at" IS NULL OR "rejected_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND (("status"::text IN ('ACTIVE', 'RETIRED', 'SUSPENDED')) = ("activated_at" IS NOT NULL))
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_suspension_complete"
  CHECK (num_nonnulls("suspended_at", "suspended_by", "suspension_reason") IN (0, 3)
         AND (("status"::text = 'SUSPENDED') = ("suspended_at" IS NOT NULL))
         AND ("suspension_reason" IS NULL OR btrim("suspension_reason") <> '')
         AND ("suspended_at" IS NULL OR "suspended_at" >= "activated_at"));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930140000_policy_suspension_from_pending';
