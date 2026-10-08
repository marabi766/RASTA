-- =============================================================================
-- Reverse of `migration.sql` (20261006140000_signature_hierarchy_version, CON-003 PR 2 round 4).
--
-- **Refuses, and changes nothing, once any of it has been used.** The recorded version is what
-- orders a later move against a signature: dropping it would turn a flagging that is decided by
-- number back into one decided by a clock that cannot decide it. So this script stops, with a
-- message, when any signature records a version, any review records one, or any reconciliation
-- task still open holds a move's version. On a database where none of it was used it restores the
-- previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check and every change commit together or
-- not at all, run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it.
-- =============================================================================

BEGIN;

LOCK TABLE "signature_authority_review", "contract_signature", "policy_reconciliation_task"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_version$
DECLARE
  versioned integer;
  reviewed integer;
  open_tasks integer;
BEGIN
  SELECT count(*) INTO versioned FROM "contract_signature" WHERE "hierarchy_version" IS NOT NULL;
  SELECT count(*) INTO reviewed FROM "signature_authority_review"
    WHERE "moved_version" IS NOT NULL OR "recorded_version" IS NOT NULL;
  SELECT count(*) INTO open_tasks FROM "policy_reconciliation_task"
    WHERE "status"::text = 'PENDING' AND "moved_version" IS NOT NULL;
  IF versioned > 0 OR reviewed > 0 OR open_tasks > 0 THEN
    RAISE EXCEPTION 'down refused: % signature(s) record a hierarchy version, % review(s) record a version and % open reconciliation task(s) hold a move version; nothing was changed', versioned, reviewed, open_tasks
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_version$;

ALTER TABLE "signature_authority_review" DROP CONSTRAINT IF EXISTS "ck_review_versions";
ALTER TABLE "signature_authority_review"
  DROP COLUMN IF EXISTS "recorded_version",
  DROP COLUMN IF EXISTS "moved_version";

ALTER TABLE "policy_reconciliation_task" DROP CONSTRAINT IF EXISTS "ck_policy_reconciliation_moved_version";
ALTER TABLE "policy_reconciliation_task" DROP COLUMN IF EXISTS "moved_version";

ALTER TABLE "contract_signature" DROP CONSTRAINT IF EXISTS "ck_signature_hierarchy_version";
ALTER TABLE "contract_signature" DROP COLUMN IF EXISTS "hierarchy_version";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006140000_signature_hierarchy_version';

COMMIT;
