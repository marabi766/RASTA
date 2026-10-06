-- =============================================================================
-- Reverse of `migration.sql` (20261006120000_signature_authority_review, CON-003 PR 2 round 3).
--
-- **Refuses, and changes nothing, once any of it has been used.** A review is the record that a
-- signature may rest on authority that changed while it was being made, and the evidence columns
-- are what let a later move be compared with a signature: dropping either would let that fact
-- disappear. An open reconciliation task also holds the move instant its flagging needs. So this
-- script stops, with a message, when any review exists, any signature carries evidence, or any
-- reconciliation task is still open. On a database where none of it was used it restores the
-- previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check and every change commit together or
-- not at all, run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it.
-- =============================================================================

BEGIN;

LOCK TABLE "signature_authority_review", "contract_signature", "policy_reconciliation_task"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_review$
DECLARE
  reviews integer;
  evidenced integer;
  open_tasks integer;
BEGIN
  SELECT count(*) INTO reviews FROM "signature_authority_review";
  SELECT count(*) INTO evidenced FROM "contract_signature" WHERE "hierarchy_read_at" IS NOT NULL;
  SELECT count(*) INTO open_tasks FROM "policy_reconciliation_task" WHERE "status"::text = 'PENDING';
  IF reviews > 0 OR evidenced > 0 OR open_tasks > 0 THEN
    RAISE EXCEPTION 'down refused: % authority review(s), % signature(s) with hierarchy evidence and % open reconciliation task(s) exist; nothing was changed', reviews, evidenced, open_tasks
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_review$;

DROP TRIGGER IF EXISTS "tg_signature_authority_review_no_truncate" ON "signature_authority_review";
DROP TRIGGER IF EXISTS "tg_signature_authority_review_immutable" ON "signature_authority_review";
DROP TABLE IF EXISTS "signature_authority_review";
DROP FUNCTION IF EXISTS "signature_authority_review_guard"();

ALTER TABLE "contract_signature" DROP CONSTRAINT IF EXISTS "ck_signature_hierarchy_evidence";
ALTER TABLE "contract_signature"
  DROP COLUMN IF EXISTS "hierarchy_commit_deadline",
  DROP COLUMN IF EXISTS "hierarchy_read_at",
  DROP COLUMN IF EXISTS "hierarchy_answer",
  DROP COLUMN IF EXISTS "hierarchy_author_organization_id";

ALTER TABLE "policy_reconciliation_task" DROP COLUMN IF EXISTS "moved_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006120000_signature_authority_review';

COMMIT;
