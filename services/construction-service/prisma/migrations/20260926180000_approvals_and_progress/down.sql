-- =============================================================================
-- Reverse of `migration.sql` (20260926180000_approvals_and_progress).
--
-- **This destroys every approval policy, every approval decision and every
-- progress report**, including who decided and why. Events already published
-- have left; audit-service keeps its own copy of each.
--
-- A project's status is not rewritten: a project that reached APPROVED,
-- IN_PROGRESS or COMPLETED under these tables keeps that status, with no
-- record left of the approvals behind it. Reverse only before any project has
-- left DRAFT, CHANGES_REQUESTED or CANCELLED, or accept that loss knowingly.
-- =============================================================================

DROP TABLE IF EXISTS "progress_report";
DROP TABLE IF EXISTS "approval";
DROP TABLE IF EXISTS "approval_policy_step";
DROP TABLE IF EXISTS "approval_policy";

ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "ck_project_approval_round_nonneg";
ALTER TABLE "project" DROP COLUMN IF EXISTS "approval_round";

DROP TYPE IF EXISTS "ProgressReportStatus";
DROP TYPE IF EXISTS "ApprovalStatus";
DROP TYPE IF EXISTS "ApprovalPolicyStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926180000_approvals_and_progress';
