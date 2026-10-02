-- Reverse of `migration.sql` (20261002100000_payment_intent_creator_identity).
--
-- Drops the recorded creator identities. The operator path then has nothing
-- to compare an approver's identity against; it is the B3 migration's own
-- rollback (20261001100000) that removes the path itself.
BEGIN;

SET LOCAL lock_timeout = '3s';

-- Refuses FIRST, before changing anything, while the operator path has any
-- history (Codex round 3 on #175). Rolled back newest-first, this script runs
-- before 20261001100000's, which refuses on that same history; changing this
-- schema and then stopping there would leave a partially rolled-back database
-- the current client cannot read. So the newest down script checks every
-- condition its dependents refuse on — table locks first, then the counts.
DO $$
DECLARE resolution_count BIGINT := 0;
DECLARE requeue_count BIGINT := 0;
BEGIN
  IF to_regclass('payment_reconciliation_resolution') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_resolution IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO resolution_count FROM payment_reconciliation_resolution;
  END IF;
  IF to_regclass('payment_reconciliation_requeue') IS NOT NULL THEN
    LOCK TABLE payment_reconciliation_requeue IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO requeue_count FROM payment_reconciliation_requeue;
  END IF;
  IF resolution_count > 0 OR requeue_count > 0 THEN
    RAISE EXCEPTION 'the operator path holds % resolution(s) and % requeue(s); refusing to roll back beneath it',
      resolution_count, requeue_count
      USING HINT = 'Its history is the only record of the evidence and the reasons; 20261001100000 refuses on it too.';
  END IF;
END
$$;

ALTER TABLE "payment_intent" DROP CONSTRAINT IF EXISTS "ck_payment_intent_creator_identity";
ALTER TABLE "payment_intent"
  DROP COLUMN IF EXISTS "created_by_subject",
  DROP COLUMN IF EXISTS "created_by_issuer";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002100000_payment_intent_creator_identity';

COMMIT;
