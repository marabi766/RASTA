-- =============================================================================
-- construction-service — awarding an evaluated tender (CON-002 PR 10, ADR-067 § 3)
--
-- The owner's choice of one QUALIFIED bid of an EVALUATED tender: who, when, which bid,
-- its rank in the frozen matrix, the amount the winner bid, and — when the choice is not
-- the single first rank — the reason in words. One row per tender, append-only. The
-- database keeps the transition honest whatever a future write path forgets: an award row
-- is accepted only for an EVALUATED tender and a QUALIFIED bid of it; the tender becomes
-- AWARDED, and a bid AWARDED or NOT_AWARDED, only with that row; and a row cannot be
-- committed without the tender and the winning bid having moved with it. (The runtime
-- role holds DML only and owns nothing, D-045, so it cannot lift these triggers.)
-- =============================================================================

-- CreateTable
CREATE TABLE "tender_award" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "bidder_organization_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "rank" INTEGER NOT NULL,
    "tied" BOOLEAN NOT NULL,
    "matrix_digest" TEXT NOT NULL,
    "justification" TEXT,
    "standing_as_of" TIMESTAMPTZ(3) NOT NULL,
    "awarded_at" TIMESTAMPTZ(3) NOT NULL,
    "awarded_by" TEXT NOT NULL,
    "awarded_by_issuer" TEXT,
    "awarded_by_subject" TEXT,

    CONSTRAINT "tender_award_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_award_tender" ON "tender_award"("organization_id", "tender_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_award_bid" ON "tender_award"("bid_id");

-- AddForeignKey
ALTER TABLE "tender_award" ADD CONSTRAINT "tender_award_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_award" ADD CONSTRAINT "tender_award_bid_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bid"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

ALTER TABLE "tender_award" ADD CONSTRAINT "ck_tender_award_shape"
  CHECK ("rank" >= 1 AND "amount_minor" >= 0
         AND "matrix_digest" ~ '^[0-9a-f]{64}$'
         AND btrim("bid_id") <> '' AND btrim("bidder_organization_id") <> ''
         AND btrim("awarded_by") <> ''
         AND ("justification" IS NULL OR btrim("justification") <> ''));

-- The owner does not award its own tender to itself (the same base rule as a bid, ADR-067 § 4).
ALTER TABLE "tender_award" ADD CONSTRAINT "ck_tender_award_not_own"
  CHECK ("bidder_organization_id" <> "organization_id");

-- Anything other than the single first rank is justified in words (ADR-067 § 3, Q-89).
ALTER TABLE "tender_award" ADD CONSTRAINT "ck_tender_award_justified"
  CHECK (("rank" = 1 AND NOT "tied") OR "justification" IS NOT NULL);

-- The awarder's stable identity, kept beside the user id so a later check can prove whether two
-- user ids are one person: the issuer and the subject together, or neither.
ALTER TABLE "tender_award" ADD CONSTRAINT "ck_tender_award_actor_pair"
  CHECK (num_nonnulls("awarded_by_issuer", "awarded_by_subject") IN (0, 2)
         AND ("awarded_by_issuer" IS NULL
              OR (btrim("awarded_by_issuer") <> '' AND btrim("awarded_by_subject") <> '')));

-- =============================================================================
-- An award is recorded only for an EVALUATED tender and one of its QUALIFIED bids
-- =============================================================================

-- The tender row is taken FOR SHARE before its status is tested: it conflicts with the FOR UPDATE
-- every owner command holds (award, and the cancellation that follows), so an insert that saw
-- EVALUATED cannot land after a competing command has committed and moved the tender on.
CREATE FUNCTION "tender_award_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  tender_evaluated_at timestamptz;
  bid_status text;
  bid_bidder text;
BEGIN
  SELECT "status"::text, "evaluated_at" INTO tender_status, tender_evaluated_at
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
    FOR SHARE;
  IF tender_status IS DISTINCT FROM 'EVALUATED' OR tender_evaluated_at IS NULL THEN
    RAISE EXCEPTION 'ck_award_evaluated: a tender is awarded only once it is EVALUATED'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."awarded_at" < tender_evaluated_at THEN
    RAISE EXCEPTION 'ck_award_after_evaluation: an award is not dated before the evaluation was completed'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "status"::text, "bidder_organization_id" INTO bid_status, bid_bidder
    FROM "bid"
   WHERE "id" = NEW."bid_id" AND "organization_id" = NEW."organization_id"
     AND "tender_id" = NEW."tender_id";
  IF bid_status IS DISTINCT FROM 'QUALIFIED' OR bid_bidder IS DISTINCT FROM NEW."bidder_organization_id" THEN
    RAISE EXCEPTION 'ck_award_bid: only a QUALIFIED bid of this tender, and its bidder, is awarded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "bid_qualification"
                  WHERE "organization_id" = NEW."organization_id" AND "bid_id" = NEW."bid_id"
                    AND "decision"::text = 'QUALIFIED') THEN
    RAISE EXCEPTION 'ck_award_bid: the bid has no recorded qualification'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_award_guard"
  BEFORE INSERT ON "tender_award"
  FOR EACH ROW EXECUTE FUNCTION "tender_award_guard"();

-- A tender becomes AWARDED only with its award recorded. Only the one edge (EVALUATED → AWARDED) is
-- judged here; any other edge into AWARDED is the status guard's to refuse, with its own error.
CREATE FUNCTION "tender_award_recorded"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "tender_award"
                  WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."id") THEN
    RAISE EXCEPTION 'ck_tender_award_recorded: a tender is AWARDED only by a recorded award'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_status_requires_award"
  BEFORE UPDATE OF "status" ON "tender"
  FOR EACH ROW
  WHEN (OLD."status"::text = 'EVALUATED' AND NEW."status"::text = 'AWARDED')
  EXECUTE FUNCTION "tender_award_recorded"();

-- A bid is AWARDED only as the bid the award names, and NOT_AWARDED only when the award names another.
-- (Only the edge out of QUALIFIED is judged here; the bid guard refuses every other with its own error.)
CREATE FUNCTION "bid_award_recorded"() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'AWARDED' THEN
    IF NOT EXISTS (SELECT 1 FROM "tender_award"
                    WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
                      AND "bid_id" = NEW."id") THEN
      RAISE EXCEPTION 'ck_bid_award_recorded: a bid is AWARDED only as the bid an award names'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status"::text = 'NOT_AWARDED' THEN
    IF NOT EXISTS (SELECT 1 FROM "tender_award"
                    WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
                      AND "bid_id" <> NEW."id") THEN
      RAISE EXCEPTION 'ck_bid_award_recorded: a bid is NOT_AWARDED only once an award names another bid'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_bid_status_requires_award"
  BEFORE UPDATE OF "status" ON "bid"
  FOR EACH ROW
  WHEN (OLD."status"::text = 'QUALIFIED' AND NEW."status"::text IN ('AWARDED', 'NOT_AWARDED'))
  EXECUTE FUNCTION "bid_award_recorded"();

-- At commit, an award row stands only if the tender and the winning bid moved with it: a transaction
-- that inserted the row and forgot the rest (or lost the race for the status) does not commit.
CREATE FUNCTION "tender_award_consistent"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  bid_status text;
BEGIN
  SELECT "status"::text INTO tender_status
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id";
  SELECT "status"::text INTO bid_status FROM "bid" WHERE "id" = NEW."bid_id";
  IF tender_status IS DISTINCT FROM 'AWARDED' OR bid_status IS DISTINCT FROM 'AWARDED' THEN
    RAISE EXCEPTION 'ck_award_consistent: an award is committed with its tender and winning bid AWARDED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_tender_award_consistent"
  AFTER INSERT ON "tender_award"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "tender_award_consistent"();

-- Append-only: the function the receipt chain, the access log and the evaluation already use.
CREATE TRIGGER "tg_tender_award_append_only"
  BEFORE UPDATE OR DELETE ON "tender_award"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_tender_award_no_truncate"
  BEFORE TRUNCATE ON "tender_award"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();
