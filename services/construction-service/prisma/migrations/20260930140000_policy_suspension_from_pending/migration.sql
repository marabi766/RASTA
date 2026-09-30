-- =============================================================================
-- construction-service — a policy still PENDING_PLATFORM_APPROVAL can be
-- SUSPENDED too (Q-83)
--
-- Approval checks the hierarchy before its transaction, so an
-- ORGANIZATION_MOVED can land between that check and the activation. The
-- consumer therefore suspends a pending policy whose union no longer governs
-- its organization, and approval finds it SUSPENDED and refuses.
--
-- Such a policy was never approved: it has no `activated_at`. The activation
-- constraint of 20260930130000_policy_suspension assumed every SUSPENDED policy
-- had been ACTIVE. It now says what is actually true:
--
--   - ACTIVE and RETIRED always name the platform approval;
--   - SUSPENDED may or may not (it was ACTIVE, or it was pending);
--   - every other state has none.
--
-- Compared as text, for the reason given in that migration.
-- =============================================================================

ALTER TABLE "approval_policy" DROP CONSTRAINT "ck_policy_activation_complete";
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND ("status"::text NOT IN ('ACTIVE', 'RETIRED') OR "activated_at" IS NOT NULL)
         AND ("status"::text IN ('ACTIVE', 'RETIRED', 'SUSPENDED') OR "activated_at" IS NULL)
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));
