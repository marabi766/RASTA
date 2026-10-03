-- =============================================================================
-- Reverse of `migration.sql` (#188, part B).
--
-- **Not refused when identities exist**, unlike the migrations around it, and on purpose:
-- the user ids stay, and dropping the pairs only turns every row back into what an older
-- row already is — UNKNOWN — which every check that reads it refuses (fail closed). Nothing
-- is lost that a check would let through; a forward re-apply leaves them UNKNOWN until the
-- remedies in docs/09 § 9.3 are applied. Locks the tables first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "approval_policy", "bid_qualification", "bid_evaluation",
           "bid_evaluation_recusal" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "bid_evaluation_recusal" DROP CONSTRAINT IF EXISTS "ck_bid_recusal_evaluator_identity";
ALTER TABLE "bid_evaluation_recusal" DROP COLUMN IF EXISTS "evaluator_subject";
ALTER TABLE "bid_evaluation_recusal" DROP COLUMN IF EXISTS "evaluator_issuer";

ALTER TABLE "bid_evaluation" DROP CONSTRAINT IF EXISTS "ck_bid_evaluation_evaluator_identity";
ALTER TABLE "bid_evaluation" DROP COLUMN IF EXISTS "evaluator_subject";
ALTER TABLE "bid_evaluation" DROP COLUMN IF EXISTS "evaluator_issuer";

ALTER TABLE "bid_qualification" DROP CONSTRAINT IF EXISTS "ck_bid_qualification_decided_by_identity";
ALTER TABLE "bid_qualification" DROP COLUMN IF EXISTS "decided_by_subject";
ALTER TABLE "bid_qualification" DROP COLUMN IF EXISTS "decided_by_issuer";

ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_submitted_by_identity";
ALTER TABLE "approval_policy" DROP CONSTRAINT IF EXISTS "ck_policy_created_by_identity";
ALTER TABLE "approval_policy" DROP COLUMN IF EXISTS "submitted_by_subject";
ALTER TABLE "approval_policy" DROP COLUMN IF EXISTS "submitted_by_issuer";
ALTER TABLE "approval_policy" DROP COLUMN IF EXISTS "created_by_subject";
ALTER TABLE "approval_policy" DROP COLUMN IF EXISTS "created_by_issuer";

ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_opening_proposed_by_identity";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_evaluated_by_identity";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_published_by_identity";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_created_by_identity";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opening_proposed_by_subject";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opening_proposed_by_issuer";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "evaluated_by_subject";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "evaluated_by_issuer";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_by_subject";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_by_issuer";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "created_by_subject";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "created_by_issuer";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261003120000_actor_stable_identity';

COMMIT;
