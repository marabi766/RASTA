-- =============================================================================
-- construction-service — evaluating the opened bids (CON-002 PR 9, ADR-067 § 2, § 4)
--
-- A decision on each opened bid (QUALIFIED or DISQUALIFIED), an evaluator's scores
-- against the tender's frozen criteria, an evaluator standing down (recusal), and when
-- the evaluation was completed (EVALUATING → EVALUATED). Everything is append-only and
-- is accepted only while the tender is EVALUATING: once `evaluate` has run the matrix
-- cannot change, whatever write path forgets. (The runtime role holds DML only and owns
-- nothing, D-045, so it cannot lift these triggers.)
-- =============================================================================

-- CreateEnum
CREATE TYPE "QualificationDecision" AS ENUM ('QUALIFIED', 'DISQUALIFIED');

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "evaluated_at" TIMESTAMPTZ(3),
ADD COLUMN "evaluated_by" TEXT;

-- AlterTable
ALTER TABLE "bid_access_log" ADD COLUMN "refusal_code" TEXT;

-- CreateTable
CREATE TABLE "bid_qualification" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "decision" "QualificationDecision" NOT NULL,
    "reason_code" TEXT,
    "reason_text" TEXT,
    "standing_as_of" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by" TEXT NOT NULL,

    CONSTRAINT "bid_qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_evaluation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bid_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_evaluation_recusal" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "recused_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bid_evaluation_recusal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_evaluation_score" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "evaluation_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "criterion_code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "score_scaled" INTEGER NOT NULL,
    "scored_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bid_evaluation_score_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_qualification_bid" ON "bid_qualification"("organization_id", "tender_id", "bid_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_evaluation_evaluator" ON "bid_evaluation"("organization_id", "tender_id", "bid_id", "evaluator_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_evaluation_org_id" ON "bid_evaluation"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_recusal_evaluator" ON "bid_evaluation_recusal"("organization_id", "tender_id", "bid_id", "evaluator_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bid_score_cell_revision" ON "bid_evaluation_score"("organization_id", "evaluation_id", "criterion_code", "revision");

-- CreateIndex
CREATE INDEX "ix_bid_score_org_tender_bid" ON "bid_evaluation_score"("organization_id", "tender_id", "bid_id");

-- AddForeignKey
ALTER TABLE "bid_qualification" ADD CONSTRAINT "bid_qualification_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_evaluation" ADD CONSTRAINT "bid_evaluation_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_evaluation_recusal" ADD CONSTRAINT "bid_evaluation_recusal_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_evaluation_score" ADD CONSTRAINT "bid_evaluation_score_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bid_evaluation_score" ADD CONSTRAINT "bid_evaluation_score_organization_id_evaluation_id_fkey" FOREIGN KEY ("organization_id", "evaluation_id") REFERENCES "bid_evaluation"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Completing the evaluation names who and when, both or neither; never before the opening.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_evaluation_complete"
  CHECK (num_nonnulls("evaluated_at", "evaluated_by") IN (0, 2)
         AND ("evaluated_by" IS NULL OR btrim("evaluated_by") <> '')
         AND ("evaluated_at" IS NULL OR ("opened_at" IS NOT NULL AND "evaluated_at" >= "opened_at")));

-- Why a read was refused is a closed code, and only a refusal has one.
ALTER TABLE "bid_access_log" ADD CONSTRAINT "ck_bid_access_refusal_code"
  CHECK ("refusal_code" IS NULL OR ("outcome" = 'REFUSED' AND btrim("refusal_code") <> ''));

-- A disqualification says why (a closed code, and in words); a qualification gives no reason.
ALTER TABLE "bid_qualification" ADD CONSTRAINT "ck_bid_qualification_reason"
  CHECK (("decision"::text = 'DISQUALIFIED'
          AND "reason_code" IS NOT NULL AND btrim("reason_code") <> ''
          AND "reason_text" IS NOT NULL AND btrim("reason_text") <> '')
      OR ("decision"::text = 'QUALIFIED' AND "reason_code" IS NULL AND "reason_text" IS NULL));

ALTER TABLE "bid_qualification" ADD CONSTRAINT "ck_bid_qualification_text_not_blank"
  CHECK (btrim("bid_id") <> '' AND btrim("decided_by") <> '');

ALTER TABLE "bid_evaluation" ADD CONSTRAINT "ck_bid_evaluation_text_not_blank"
  CHECK (btrim("bid_id") <> '' AND btrim("evaluator_id") <> '');

ALTER TABLE "bid_evaluation_recusal" ADD CONSTRAINT "ck_bid_recusal_text_not_blank"
  CHECK (btrim("bid_id") <> '' AND btrim("evaluator_id") <> '' AND btrim("reason_code") <> '');

ALTER TABLE "bid_evaluation_score" ADD CONSTRAINT "ck_bid_score_shape"
  CHECK ("revision" >= 1 AND "score_scaled" >= 0
         AND btrim("criterion_code") <> '' AND btrim("evaluator_id") <> '');

-- =============================================================================
-- Append-only, and only while the tender is EVALUATING
-- =============================================================================

-- Each guard takes the tender row FOR SHARE before it tests the status: it conflicts with the FOR UPDATE
-- that `evaluate` (and every owner command) holds, so an insert cannot pass the EVALUATING check while the
-- evaluation is being completed and then land after EVALUATED commits and change the frozen matrix.
--
-- Each trigger below reads the tender itself rather than calling a shared helper: a function a
-- trigger calls needs EXECUTE for the runtime role, which the role split (D-045) does not give.
-- A decision on a bid: the tender is EVALUATING, the bid is one of its own and still OPENED.
CREATE FUNCTION "bid_qualification_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_bid_qualification_guard"
  BEFORE INSERT ON "bid_qualification"
  FOR EACH ROW EXECUTE FUNCTION "bid_qualification_guard"();

-- A bid is QUALIFIED or DISQUALIFIED only by the decision that says so.
CREATE FUNCTION "bid_decision_recorded"() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text IN ('QUALIFIED', 'DISQUALIFIED') AND NEW."status" <> OLD."status" THEN
    IF NOT EXISTS (SELECT 1 FROM "bid_qualification"
                    WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."id"
                      AND "decision"::text = NEW."status"::text) THEN
      RAISE EXCEPTION 'ck_bid_decision_recorded: a bid is %, only by a recorded decision', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_bid_status_requires_decision"
  BEFORE UPDATE OF "status" ON "bid"
  FOR EACH ROW EXECUTE FUNCTION "bid_decision_recorded"();

-- An evaluator's claim on a bid: the tender is EVALUATING, the bid is QUALIFIED, they have not stood down.
CREATE FUNCTION "bid_evaluation_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_bid_evaluation_guard"
  BEFORE INSERT ON "bid_evaluation"
  FOR EACH ROW EXECUTE FUNCTION "bid_evaluation_guard"();

-- Standing down: while the tender is EVALUATING, from a bid still being decided on or evaluated.
CREATE FUNCTION "bid_recusal_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_bid_recusal_guard"
  BEFORE INSERT ON "bid_evaluation_recusal"
  FOR EACH ROW EXECUTE FUNCTION "bid_recusal_guard"();

-- A cell of the matrix: the tender is EVALUATING, it belongs to the named evaluation, the
-- criterion is one of the tender's frozen ones, the score is inside its range (and a PASS_FAIL
-- criterion is 0 or full marks), and the revision is the next one of that cell.
CREATE FUNCTION "bid_score_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_bid_score_guard"
  BEFORE INSERT ON "bid_evaluation_score"
  FOR EACH ROW EXECUTE FUNCTION "bid_score_guard"();

-- Append-only: the function the receipt chain and the access log already use.
CREATE TRIGGER "tg_bid_qualification_append_only"
  BEFORE UPDATE OR DELETE ON "bid_qualification"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_qualification_no_truncate"
  BEFORE TRUNCATE ON "bid_qualification"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

CREATE TRIGGER "tg_bid_evaluation_append_only"
  BEFORE UPDATE OR DELETE ON "bid_evaluation"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_evaluation_no_truncate"
  BEFORE TRUNCATE ON "bid_evaluation"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

CREATE TRIGGER "tg_bid_recusal_append_only"
  BEFORE UPDATE OR DELETE ON "bid_evaluation_recusal"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_recusal_no_truncate"
  BEFORE TRUNCATE ON "bid_evaluation_recusal"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

CREATE TRIGGER "tg_bid_score_append_only"
  BEFORE UPDATE OR DELETE ON "bid_evaluation_score"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_bid_score_no_truncate"
  BEFORE TRUNCATE ON "bid_evaluation_score"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();
