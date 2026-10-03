-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 11).
--
-- **Refused once any tender approval exists** (a step of a tender round, a request, or a row of the
-- log). A request is the record of who asked for what, on which version, and who allowed it; the
-- steps are the decisions of the authority; the log says who tried what. They explain why a tender
-- was published, awarded or cancelled, and the events that announced those have left the outbox.
-- Dropping them would destroy that, and the tender's status would stand with nothing behind it.
-- Locks the tables first, so no row is written between the check and the drop; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "approval", "tender_approval_request", "tender_approval_log" IN ACCESS EXCLUSIVE MODE;

DO $preflight_tender_approvals$
DECLARE
  steps bigint;
  requests bigint;
  logged bigint;
BEGIN
  SELECT count(*) INTO steps FROM "approval" WHERE "tender_id" IS NOT NULL;
  SELECT count(*) INTO requests FROM "tender_approval_request";
  SELECT count(*) INTO logged FROM "tender_approval_log";
  IF steps + requests + logged > 0 THEN
    RAISE EXCEPTION 'down refused: tender approvals exist (% step(s), % request(s), % log row(s)); dropping them would destroy the record of who asked for and who allowed a publication, an award or a cancellation. Keep this migration.',
      steps, requests, logged
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_tender_approvals$;

DROP TRIGGER IF EXISTS "tg_tender_status_requires_approval" ON "tender";
DROP FUNCTION IF EXISTS "tender_status_requires_approval"();

DROP TRIGGER IF EXISTS "tg_approval_tender_guard" ON "approval";
DROP FUNCTION IF EXISTS "approval_tender_guard"();

DROP TABLE IF EXISTS "tender_approval_log";
DROP TABLE IF EXISTS "tender_approval_request";

DROP FUNCTION IF EXISTS "tender_approval_request_executed"();
DROP FUNCTION IF EXISTS "tender_approval_request_has_steps"();
DROP FUNCTION IF EXISTS "tender_approval_request_guard"();

ALTER TABLE "approval" DROP CONSTRAINT IF EXISTS "ck_approval_tender_scope";
ALTER TABLE "approval" DROP CONSTRAINT IF EXISTS "approval_organization_id_tender_id_fkey";
DROP INDEX IF EXISTS "ix_approval_tender_round";
DROP INDEX IF EXISTS "ux_approval_one_pending";
DROP INDEX IF EXISTS "ux_approval_round_step";
ALTER TABLE "approval" DROP COLUMN IF EXISTS "tender_id";

-- The two project-scoped indexes as 20260926180000_approvals_and_progress wrote them.
CREATE UNIQUE INDEX "ux_approval_round_step"
    ON "approval" ("organization_id", "project_id", "workflow_key", "round", "step_order");
CREATE UNIQUE INDEX "ux_approval_one_pending"
    ON "approval" ("organization_id", "project_id", "workflow_key")
 WHERE "status" = 'PENDING';

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100000_tender_approvals';

COMMIT;
