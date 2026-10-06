-- =============================================================================
-- Reverse of `migration.sql` (20261006100000_policy_suspension, CON-003 PR 2 review round 2).
--
-- **Refuses, and changes nothing, while a reconciliation task is open** (a re-check a move asked
-- for that nobody has done), **or once a policy has been suspended.** That a policy stopped
-- authorising signatures, when, and why, is the record of why a signature was refused for an
-- employer; the older enum cannot hold the value, and turning the policy into a RETIRED one would
-- rewrite who ended it. So this script stops, with a message, when any `approval_policy` row is
-- SUSPENDED or any `policy_reconciliation_task` is still open. On a database where neither holds
-- it restores the previous schema exactly; the queue's finished (DONE) tasks are history of work
-- already done and go with the table.
--
-- The whole file is one transaction, so it holds with `psql --file` (autocommit by default) as with
-- a single `-c`: the lock, the check and every change commit together or not at all, and nothing
-- can be written between the check and the drops. Run it with `-v ON_ERROR_STOP=1`; the explicit
-- transaction keeps a refusal from leaving the later statements applied even without it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

LOCK TABLE "approval_policy", "policy_reconciliation_task" IN ACCESS EXCLUSIVE MODE;

DO $preflight_suspension$
DECLARE
  suspended integer;
  open_tasks integer;
BEGIN
  SELECT count(*) INTO suspended FROM "approval_policy" WHERE "status"::text = 'SUSPENDED';
  -- An open task is a re-check a move asked for and nobody has done yet: dropping it would
  -- leave a stranded policy in force with nothing left to find it (review round 3).
  SELECT count(*) INTO open_tasks FROM "policy_reconciliation_task" WHERE "status"::text = 'PENDING';
  IF suspended > 0 OR open_tasks > 0 THEN
    RAISE EXCEPTION 'down refused: % suspended approval polic(ies) and % open reconciliation task(s) exist; nothing was changed', suspended, open_tasks
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_suspension$;

DROP TABLE IF EXISTS "policy_reconciliation_task";
DROP TYPE IF EXISTS "PolicyReconciliationStatus";

-- The guard as the signing_policy migration left it.
CREATE OR REPLACE FUNCTION "approval_policy_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."author_organization_id" IS DISTINCT FROM OLD."author_organization_id"
       OR NEW."author_role" IS DISTINCT FROM OLD."author_role"
       OR NEW."workflow_key" IS DISTINCT FROM OLD."workflow_key"
       OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
       OR NEW."label" IS DISTINCT FROM OLD."label"
       OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
       OR NEW."is_sample" IS DISTINCT FROM OLD."is_sample"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_by_issuer" IS DISTINCT FROM OLD."created_by_issuer"
       OR NEW."created_by_subject" IS DISTINCT FROM OLD."created_by_subject"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_policy_immutable: a policy is written once; a change is a new version'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A step already taken is not rewritten.
    IF (OLD."submitted_at" IS NOT NULL
        AND (NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
             OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
             OR NEW."submitted_by_issuer" IS DISTINCT FROM OLD."submitted_by_issuer"
             OR NEW."submitted_by_subject" IS DISTINCT FROM OLD."submitted_by_subject"))
       OR (OLD."activated_at" IS NOT NULL
           AND (NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
                OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by"))
       OR (OLD."rejected_at" IS NOT NULL
           AND (NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at"
                OR NEW."rejected_by" IS DISTINCT FROM OLD."rejected_by"
                OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"))
       OR (OLD."retired_at" IS NOT NULL
           AND (NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
                OR NEW."retired_by" IS DISTINCT FROM OLD."retired_by"))
    THEN
      RAISE EXCEPTION 'ck_policy_history_immutable: who took a step, and when, is never rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PENDING_PLATFORM_APPROVAL')
                OR (OLD."status" = 'PENDING_PLATFORM_APPROVAL' AND NEW."status" IN ('ACTIVE', 'REJECTED'))
                OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')) THEN
      RAISE EXCEPTION 'ck_policy_transition: a policy cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_policy_not_erasable: a policy is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_suspension_complete";
ALTER TABLE "approval_policy"
  DROP COLUMN IF EXISTS "suspended_at",
  DROP COLUMN IF EXISTS "suspended_by",
  DROP COLUMN IF EXISTS "suspension_reason";

-- Rebuild the enum without SUSPENDED. Everything that names the column is dropped first and put
-- back as the signing_policy migration wrote it.
DROP INDEX IF EXISTS "ux_approval_policy_active";
ALTER TABLE "approval_policy" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_submission_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_activation_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_rejection_complete";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_retirement_complete";

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

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006100000_policy_suspension';

COMMIT;
