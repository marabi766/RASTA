-- =============================================================================
-- construction-service — the stable identity of the people a later check compares (#188, part B)
--
-- `user_id` is `rasta_uid ?? sub` (AuthGuard), so one person can carry two user ids and
-- pass a separation-of-duties check alone. Beside every user id that a later check compares
-- with another person, the token's verified issuer and subject are now kept:
--
--   tender                  the opening's proposer (bid-opening four eyes, Q-91), the creator and
--                           the publisher (EVALUATOR_NOT_TENDER_AUTHOR), the evaluation's completer
--   approval_policy         the author and the submitter (policy four eyes, Q-70 (7))
--   bid_qualification       who decided on a bid       } the evaluators, whom an awarder is
--   bid_evaluation          who evaluated a bid        } compared with (AWARDER_NOT_EVALUATOR)
--   bid_evaluation_recusal  who stood down from a bid  }
--
-- Every pair is nullable and **not backfilled**: the issuer and subject behind an old user id
-- cannot be known from this service's data (reading identity-service's would break A-01, and
-- would still be a guess). An old row is therefore UNKNOWN, and every check that reads it fails
-- closed (`ACTOR_IDENTITY_UNKNOWN`). The remedies are documented in docs/09 § 9.3: an old
-- opening proposal is withdrawn and proposed again; an old pending or draft policy is withdrawn
-- and a new one written. New writes always fill the pairs (tested; a NOT NULL on new rows alone
-- cannot be expressed without breaking the old ones).
--
-- Adding nullable columns rewrites no row and fires no row trigger, so the append-only tables
-- (`bid_append_only`) accept this migration unchanged.
--
-- Limitation of `down.sql`: rolling back DISCARDS every recorded issuer and subject. It is not
-- refused, because the user ids stay and every row merely becomes UNKNOWN again, which every check
-- refuses (fail closed) — but the identities cannot be recovered by re-applying this migration:
-- after a rollback, open proposals, pending policies and evaluations must follow the remedies above
-- as if they had been written before it.
-- =============================================================================

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "created_by_issuer" TEXT,
ADD COLUMN "created_by_subject" TEXT,
ADD COLUMN "published_by_issuer" TEXT,
ADD COLUMN "published_by_subject" TEXT,
ADD COLUMN "evaluated_by_issuer" TEXT,
ADD COLUMN "evaluated_by_subject" TEXT,
ADD COLUMN "opening_proposed_by_issuer" TEXT,
ADD COLUMN "opening_proposed_by_subject" TEXT;

-- AlterTable
ALTER TABLE "approval_policy" ADD COLUMN "created_by_issuer" TEXT,
ADD COLUMN "created_by_subject" TEXT,
ADD COLUMN "submitted_by_issuer" TEXT,
ADD COLUMN "submitted_by_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_qualification" ADD COLUMN "decided_by_issuer" TEXT,
ADD COLUMN "decided_by_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_evaluation" ADD COLUMN "evaluator_issuer" TEXT,
ADD COLUMN "evaluator_subject" TEXT;

-- AlterTable
ALTER TABLE "bid_evaluation_recusal" ADD COLUMN "evaluator_issuer" TEXT,
ADD COLUMN "evaluator_subject" TEXT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Each pair is both or neither, never blank, and only beside the user id it describes: half a
-- pair proves nothing about who someone is, and an identity with no actor names nobody.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_created_by_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL
              OR (btrim("created_by_issuer") <> '' AND btrim("created_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_published_by_identity"
  CHECK (num_nonnulls("published_by_issuer", "published_by_subject") IN (0, 2)
         AND ("published_by_issuer" IS NULL
              OR ("published_by" IS NOT NULL
                  AND btrim("published_by_issuer") <> '' AND btrim("published_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_evaluated_by_identity"
  CHECK (num_nonnulls("evaluated_by_issuer", "evaluated_by_subject") IN (0, 2)
         AND ("evaluated_by_issuer" IS NULL
              OR ("evaluated_by" IS NOT NULL
                  AND btrim("evaluated_by_issuer") <> '' AND btrim("evaluated_by_subject") <> '')));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_opening_proposed_by_identity"
  CHECK (num_nonnulls("opening_proposed_by_issuer", "opening_proposed_by_subject") IN (0, 2)
         AND ("opening_proposed_by_issuer" IS NULL
              OR ("opening_proposed_by" IS NOT NULL
                  AND btrim("opening_proposed_by_issuer") <> ''
                  AND btrim("opening_proposed_by_subject") <> '')));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_created_by_identity"
  CHECK (num_nonnulls("created_by_issuer", "created_by_subject") IN (0, 2)
         AND ("created_by_issuer" IS NULL
              OR (btrim("created_by_issuer") <> '' AND btrim("created_by_subject") <> '')));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_submitted_by_identity"
  CHECK (num_nonnulls("submitted_by_issuer", "submitted_by_subject") IN (0, 2)
         AND ("submitted_by_issuer" IS NULL
              OR ("submitted_by" IS NOT NULL
                  AND btrim("submitted_by_issuer") <> '' AND btrim("submitted_by_subject") <> '')));

ALTER TABLE "bid_qualification" ADD CONSTRAINT "ck_bid_qualification_decided_by_identity"
  CHECK (num_nonnulls("decided_by_issuer", "decided_by_subject") IN (0, 2)
         AND ("decided_by_issuer" IS NULL
              OR (btrim("decided_by_issuer") <> '' AND btrim("decided_by_subject") <> '')));

ALTER TABLE "bid_evaluation" ADD CONSTRAINT "ck_bid_evaluation_evaluator_identity"
  CHECK (num_nonnulls("evaluator_issuer", "evaluator_subject") IN (0, 2)
         AND ("evaluator_issuer" IS NULL
              OR (btrim("evaluator_issuer") <> '' AND btrim("evaluator_subject") <> '')));

ALTER TABLE "bid_evaluation_recusal" ADD CONSTRAINT "ck_bid_recusal_evaluator_identity"
  CHECK (num_nonnulls("evaluator_issuer", "evaluator_subject") IN (0, 2)
         AND ("evaluator_issuer" IS NULL
              OR (btrim("evaluator_issuer") <> '' AND btrim("evaluator_subject") <> '')));

-- =============================================================================
-- One person is one evaluator of a bid (#188, E1 and E2)
-- =============================================================================

-- A person holds at most one evaluation of a bid, and stands down from it at most once, under
-- whatever user id: the same issuer and subject twice is the same person twice. Partial, so
-- rows written before the pair was recorded (NULL) are not compared here; the service refuses
-- them as unknown (ACTOR_IDENTITY_UNKNOWN). Prisma cannot express a partial index: SQL-only.
CREATE UNIQUE INDEX "ux_bid_evaluation_person"
  ON "bid_evaluation"("organization_id", "tender_id", "bid_id", "evaluator_issuer", "evaluator_subject")
  WHERE "evaluator_issuer" IS NOT NULL;

CREATE UNIQUE INDEX "ux_bid_recusal_person"
  ON "bid_evaluation_recusal"("organization_id", "tender_id", "bid_id", "evaluator_issuer", "evaluator_subject")
  WHERE "evaluator_issuer" IS NOT NULL;

-- The guards' recusal checks matched the evaluator by user id alone, so a person who stood down
-- under one id could decide on, claim or score the bid under another. They now match the stored
-- issuer and subject too, where the row being written has them; and a person does not stand down
-- under another id than the one their evaluation of the bid is recorded under (their scores would
-- stay in the matrix). Otherwise each function is as 20261002150000_tender_evaluation wrote it;
-- the triggers are unchanged and call the replaced bodies.

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
                AND ("evaluator_id" = NEW."decided_by"
                     OR (NEW."decided_by_issuer" IS NOT NULL
                         AND "evaluator_issuer" = NEW."decided_by_issuer"
                         AND "evaluator_subject" = NEW."decided_by_subject"))) THEN
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
                AND ("evaluator_id" = NEW."evaluator_id"
                     OR (NEW."evaluator_issuer" IS NOT NULL
                         AND "evaluator_issuer" = NEW."evaluator_issuer"
                         AND "evaluator_subject" = NEW."evaluator_subject"))) THEN
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
  IF NEW."evaluator_issuer" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "bid_evaluation"
        WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
          AND "evaluator_id" <> NEW."evaluator_id"
          AND "evaluator_issuer" = NEW."evaluator_issuer"
          AND "evaluator_subject" = NEW."evaluator_subject") THEN
    RAISE EXCEPTION 'ck_recusal_person: a person stands down under the user id they evaluate the bid with'
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
  claim_issuer text;
  claim_subject text;
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

  SELECT "bid_id", "tender_id", "evaluator_id", "evaluator_issuer", "evaluator_subject"
    INTO claim_bid, claim_tender, claim_evaluator, claim_issuer, claim_subject
    FROM "bid_evaluation"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."evaluation_id";
  IF claim_bid IS DISTINCT FROM NEW."bid_id" OR claim_tender IS DISTINCT FROM NEW."tender_id"
     OR claim_evaluator IS DISTINCT FROM NEW."evaluator_id" THEN
    RAISE EXCEPTION 'ck_score_evaluation: a score belongs to the evaluation of its own bid and evaluator'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "bid_evaluation_recusal"
              WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
                AND ("evaluator_id" = NEW."evaluator_id"
                     OR (claim_issuer IS NOT NULL
                         AND "evaluator_issuer" = claim_issuer
                         AND "evaluator_subject" = claim_subject))) THEN
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
