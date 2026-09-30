-- =============================================================================
-- construction-service — an approval policy can be SUSPENDED (Q-83)
--
-- An organization can be moved in the hierarchy (organization-service,
-- ORGANIZATION_MOVED). A policy a union wrote for an organization that is no
-- longer beneath it must stop governing. It is SUSPENDED — not deleted, not
-- transferred — with who and why recorded, in the transaction that finds it.
-- A suspended policy is never reactivated (Q-83, provisional): a new version
-- goes through the normal write / submit / approve flow.
--
-- A SUSPENDED policy still names the platform approval it once had, so
-- `activated_at` stays set. `ux_approval_policy_active` covers ACTIVE only, so
-- suspending frees the slot for the replacement.
--
-- ## The enum value and the constraints that name it
--
-- PostgreSQL allows ADD VALUE inside a transaction, but the new value cannot
-- be *used* in it — and a CHECK constraint that compares the enum column to
-- 'SUSPENDED' uses it. The two constraints below therefore compare the status
-- as text, which names the value without resolving it as an enum member.
-- =============================================================================

ALTER TYPE "ApprovalPolicyStatus" ADD VALUE 'SUSPENDED';

ALTER TABLE "approval_policy"
  ADD COLUMN "suspended_at" TIMESTAMP(3),
  ADD COLUMN "suspended_by" TEXT,
  ADD COLUMN "suspension_reason" TEXT;

-- A suspended policy was approved by the platform: it keeps `activated_at`.
ALTER TABLE "approval_policy" DROP CONSTRAINT "ck_policy_activation_complete";
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND (("status"::text IN ('ACTIVE', 'RETIRED', 'SUSPENDED')) = ("activated_at" IS NOT NULL))
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));

-- Suspension names who, when and why, exactly when the policy is SUSPENDED.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_suspension_complete"
  CHECK (num_nonnulls("suspended_at", "suspended_by", "suspension_reason") IN (0, 3)
         AND (("status"::text = 'SUSPENDED') = ("suspended_at" IS NOT NULL))
         AND ("suspension_reason" IS NULL OR btrim("suspension_reason") <> '')
         AND ("suspended_at" IS NULL OR "suspended_at" >= "activated_at"));
