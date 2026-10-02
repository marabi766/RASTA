-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 9).
--
-- **Refused once any evaluation data exists.** Decisions on bids, claims, scores and
-- recusals are append-only evidence of who judged which bid and how (ADR-067 § 2); the
-- events that announced them have left the outbox; `evaluated_at` / `evaluated_by` are
-- the only record of when and by whom the matrix was frozen; and a refused read's reason
-- is part of the access log. Dropping any of it would destroy that. Locks every table
-- first, so no row is written between the check and the drop; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "bid", "bid_access_log", "bid_qualification", "bid_evaluation",
           "bid_evaluation_recusal", "bid_evaluation_score" IN ACCESS EXCLUSIVE MODE;

DO $preflight_evaluation$
DECLARE
  decisions bigint;
  claims bigint;
  scores bigint;
  recusals bigint;
  evaluated bigint;
  refusals bigint;
BEGIN
  SELECT count(*) INTO decisions FROM "bid_qualification";
  SELECT count(*) INTO claims FROM "bid_evaluation";
  SELECT count(*) INTO scores FROM "bid_evaluation_score";
  SELECT count(*) INTO recusals FROM "bid_evaluation_recusal";
  SELECT count(*) INTO evaluated FROM "tender"
   WHERE "evaluated_at" IS NOT NULL OR "evaluated_by" IS NOT NULL;
  SELECT count(*) INTO refusals FROM "bid_access_log" WHERE "refusal_code" IS NOT NULL;
  IF decisions + claims + scores + recusals + evaluated + refusals > 0 THEN
    RAISE EXCEPTION 'down refused: evaluation data exists (% decision(s), % evaluation(s), % score(s), % recusal(s), % completed evaluation(s), % refusal reason(s)); dropping it would destroy the record of who judged which bid. Keep this migration.',
      decisions, claims, scores, recusals, evaluated, refusals
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_evaluation$;

DROP TRIGGER IF EXISTS "tg_bid_status_requires_decision" ON "bid";
DROP FUNCTION IF EXISTS "bid_decision_recorded"();

DROP TABLE IF EXISTS "bid_evaluation_score";
DROP TABLE IF EXISTS "bid_evaluation_recusal";
DROP TABLE IF EXISTS "bid_evaluation";
DROP TABLE IF EXISTS "bid_qualification";

DROP FUNCTION IF EXISTS "bid_score_guard"();
DROP FUNCTION IF EXISTS "bid_recusal_guard"();
DROP FUNCTION IF EXISTS "bid_evaluation_guard"();
DROP FUNCTION IF EXISTS "bid_qualification_guard"();
DROP FUNCTION IF EXISTS "evaluation_assert_open"(text, text);

DROP TYPE IF EXISTS "QualificationDecision";

ALTER TABLE "bid_access_log" DROP CONSTRAINT IF EXISTS "ck_bid_access_refusal_code";
ALTER TABLE "bid_access_log" DROP COLUMN IF EXISTS "refusal_code";

ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_evaluation_complete";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "evaluated_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "evaluated_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002150000_tender_evaluation';

COMMIT;
