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

-- The guards as 20261002150000_tender_evaluation wrote them.

CREATE OR REPLACE FUNCTION "bid_qualification_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  bid_status text;
BEGIN
  SELECT "status"::text INTO tender_status
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
    FOR SHARE;
  IF tender_status IS DISTINCT FROM 'EVALUATING' THEN
    RAISE EXCEPTION 'ck_evaluation_open: evaluation is recorded only while the tender is EVALUATING'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status"::text INTO bid_status FROM "bid"
   WHERE "id" = NEW."bid_id" AND "organization_id" = NEW."organization_id"
     AND "tender_id" = NEW."tender_id";
  IF bid_status IS DISTINCT FROM 'OPENED' THEN
    RAISE EXCEPTION 'ck_qualification_bid: only an OPENED bid of this tender is decided on'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "bid_evaluation_recusal"
              WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
                AND "evaluator_id" = NEW."decided_by") THEN
    RAISE EXCEPTION 'ck_qualification_recused: an evaluator who stood down from a bid does not decide on it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "bid_evaluation_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  bid_status text;
BEGIN
  SELECT "status"::text INTO tender_status
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
    FOR SHARE;
  IF tender_status IS DISTINCT FROM 'EVALUATING' THEN
    RAISE EXCEPTION 'ck_evaluation_open: evaluation is recorded only while the tender is EVALUATING'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status"::text INTO bid_status FROM "bid"
   WHERE "id" = NEW."bid_id" AND "organization_id" = NEW."organization_id"
     AND "tender_id" = NEW."tender_id";
  IF bid_status IS DISTINCT FROM 'QUALIFIED' THEN
    RAISE EXCEPTION 'ck_evaluation_bid: only a QUALIFIED bid of this tender is evaluated'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "bid_evaluation_recusal"
              WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
                AND "evaluator_id" = NEW."evaluator_id") THEN
    RAISE EXCEPTION 'ck_evaluation_recused: an evaluator who stood down from a bid does not evaluate it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "bid_recusal_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  bid_status text;
BEGIN
  SELECT "status"::text INTO tender_status
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
    FOR SHARE;
  IF tender_status IS DISTINCT FROM 'EVALUATING' THEN
    RAISE EXCEPTION 'ck_evaluation_open: evaluation is recorded only while the tender is EVALUATING'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status"::text INTO bid_status FROM "bid"
   WHERE "id" = NEW."bid_id" AND "organization_id" = NEW."organization_id"
     AND "tender_id" = NEW."tender_id";
  IF bid_status IS NULL OR bid_status NOT IN ('OPENED', 'QUALIFIED') THEN
    RAISE EXCEPTION 'ck_recusal_bid: an evaluator stands down only from an OPENED or QUALIFIED bid of this tender'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "bid_score_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  claim_bid text;
  claim_tender text;
  claim_evaluator text;
  method text;
  top integer;
  previous integer;
BEGIN
  SELECT "status"::text INTO tender_status
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
    FOR SHARE;
  IF tender_status IS DISTINCT FROM 'EVALUATING' THEN
    RAISE EXCEPTION 'ck_evaluation_open: evaluation is recorded only while the tender is EVALUATING'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "bid_id", "tender_id", "evaluator_id" INTO claim_bid, claim_tender, claim_evaluator
    FROM "bid_evaluation"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."evaluation_id";
  IF claim_bid IS DISTINCT FROM NEW."bid_id" OR claim_tender IS DISTINCT FROM NEW."tender_id"
     OR claim_evaluator IS DISTINCT FROM NEW."evaluator_id" THEN
    RAISE EXCEPTION 'ck_score_evaluation: a score belongs to the evaluation of its own bid and evaluator'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "bid_evaluation_recusal"
              WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
                AND "evaluator_id" = NEW."evaluator_id") THEN
    RAISE EXCEPTION 'ck_score_recused: an evaluator who stood down from a bid does not score it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "bid" WHERE "id" = NEW."bid_id" AND "status"::text = 'QUALIFIED') THEN
    RAISE EXCEPTION 'ck_evaluation_bid: only a QUALIFIED bid of this tender is evaluated'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "scoring_method"::text, "max_score" INTO method, top
    FROM "tender_criterion"
   WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
     AND "code" = NEW."criterion_code";
  IF method IS NULL THEN
    RAISE EXCEPTION 'ck_score_criterion: the tender has no criterion %', NEW."criterion_code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."score_scaled" > top::bigint * 100
     OR (method = 'PASS_FAIL' AND NEW."score_scaled" NOT IN (0, top::bigint * 100)) THEN
    RAISE EXCEPTION 'ck_score_range: the score is outside what criterion % allows', NEW."criterion_code"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT max("revision") INTO previous FROM "bid_evaluation_score"
   WHERE "organization_id" = NEW."organization_id" AND "evaluation_id" = NEW."evaluation_id"
     AND "criterion_code" = NEW."criterion_code";
  IF NEW."revision" <> COALESCE(previous, 0) + 1 THEN
    RAISE EXCEPTION 'ck_score_revision: a revision of a cell is the next one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "ux_bid_recusal_person";
DROP INDEX IF EXISTS "ux_bid_evaluation_person";

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
