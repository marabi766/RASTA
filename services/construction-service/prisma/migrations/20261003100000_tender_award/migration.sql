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

-- CreateTable
-- The standing check that follows every award (ADR-067 section 3, residual), kept durable: written in the
-- award's own transaction, claimed by a sweeper under a lease and a fencing token, done exactly once.
CREATE TABLE "tender_award_standing_check" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "winner_organization_id" TEXT NOT NULL,
    "awarded_by" TEXT NOT NULL,
    "awarded_at" TIMESTAMPTZ(3) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "done_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "fence" TEXT,

    CONSTRAINT "tender_award_standing_check_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_award_standing_check_tender" ON "tender_award_standing_check"("organization_id", "tender_id");

-- SQL-only (a partial index Prisma does not model): the sweeper's scan of what is still pending, oldest first.
CREATE INDEX "ix_award_standing_check_due" ON "tender_award_standing_check"("created_at", "id") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "tender_award_standing_check" ADD CONSTRAINT "tender_award_standing_check_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

-- The check is PENDING or DONE; DONE names its outcome and when, and holds no claim; a claim is a lease and
-- its fence, or neither.
ALTER TABLE "tender_award_standing_check" ADD CONSTRAINT "ck_award_standing_check_shape"
  CHECK ("status" IN ('PENDING', 'DONE')
         AND ("outcome" IS NULL OR "outcome" IN ('CLEAR', 'CONFLICT'))
         AND (("status" = 'DONE') = ("outcome" IS NOT NULL AND "done_at" IS NOT NULL))
         AND num_nonnulls("lease_until", "fence") IN (0, 2)
         AND ("status" = 'PENDING' OR "lease_until" IS NULL)
         AND "attempts" >= 0
         AND btrim("project_id") <> '' AND btrim("bid_id") <> ''
         AND btrim("winner_organization_id") <> '' AND btrim("awarded_by") <> '');

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

-- A standing check is the check of the award the tender holds, and the database holds it to that
-- whoever writes (the runtime role has DML, so what the service promises is kept here, not only there).
--
-- INSERT: the very award (tender, bid, winner, awarder, instant), the very window (it starts at the
-- instant of the standing read the award was made on, `tender_award.standing_as_of` - a later start would
-- let the sweeper miss a suspension) and the tender's own project; new, untried and unclaimed.
--
-- UPDATE: only the controlled shapes of the sweeper, and never what the check is about:
--   claim    - a lease and its fence on an unclaimed (or lapsed) check that is due, at most an hour long;
--   release  - after a failed attempt, from a live claim: attempts + 1 and a bounded backoff;
--   settle   - PENDING to DONE, from a live claim, with an outcome and its instant, and nothing else moved.
-- A DONE check is final. A CONFLICT outcome is settled only together with its event (the deferred
-- constraint trigger below). That a CLEAR outcome followed a read of supplier-service is not something a
-- database can see: it is bound to a live claim, not to the network.
CREATE FUNCTION "award_standing_check_guard"() RETURNS trigger AS $$
DECLARE
  award_standing timestamptz;
  tender_project text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a."standing_as_of", t."project_id" INTO award_standing, tender_project
      FROM "tender_award" a
      JOIN "tender" t ON t."organization_id" = a."organization_id" AND t."id" = a."tender_id"
     WHERE a."organization_id" = NEW."organization_id" AND a."tender_id" = NEW."tender_id"
       AND a."bid_id" = NEW."bid_id"
       AND a."bidder_organization_id" = NEW."winner_organization_id"
       AND a."awarded_by" = NEW."awarded_by" AND a."awarded_at" = NEW."awarded_at";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_award_standing_check_award: a standing check is the check of the award the tender holds'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."window_start" IS DISTINCT FROM award_standing THEN
      RAISE EXCEPTION 'ck_award_standing_check_window: the window starts at the instant of the standing read the award was made on'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."project_id" IS DISTINCT FROM tender_project THEN
      RAISE EXCEPTION 'ck_award_standing_check_project: a standing check names the tender''s own project'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."created_at" <> NEW."awarded_at" THEN
      RAISE EXCEPTION 'ck_award_standing_check_new: a standing check is written in the award''s own instant'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'PENDING' OR NEW."attempts" <> 0 OR NEW."outcome" IS NOT NULL
       OR NEW."done_at" IS NOT NULL OR NEW."lease_until" IS NOT NULL
       OR NEW."next_attempt_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_award_standing_check_new: a standing check starts PENDING, untried and unclaimed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What the check is about never changes, and a DONE check is final.
  IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."tender_id" <> OLD."tender_id" OR NEW."project_id" <> OLD."project_id"
     OR NEW."bid_id" <> OLD."bid_id" OR NEW."winner_organization_id" <> OLD."winner_organization_id"
     OR NEW."awarded_by" <> OLD."awarded_by" OR NEW."awarded_at" <> OLD."awarded_at"
     OR NEW."window_start" <> OLD."window_start" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'ck_award_standing_check_immutable: what a standing check is about never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'DONE' THEN
    RAISE EXCEPTION 'ck_award_standing_check_immutable: a standing check that is done is final'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'PENDING' THEN
    IF NEW."outcome" IS NOT NULL OR NEW."done_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_award_standing_check_transition: a pending check has no outcome'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lease_until" IS NOT NULL THEN
      -- claim: unclaimed or lapsed, due, attempts and backoff untouched, a lease of at most an hour
      IF NEW."attempts" <> OLD."attempts" OR NEW."next_attempt_at" IS DISTINCT FROM OLD."next_attempt_at" THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: a claim changes neither the attempts nor the backoff'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."fence" IS NOT NULL AND OLD."lease_until" > clock_timestamp() THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: the check is held under a live lease'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."next_attempt_at" IS NOT NULL AND OLD."next_attempt_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: the check is not due until its backoff has passed'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."lease_until" > clock_timestamp() + interval '1 hour' THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: a lease is at most an hour'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- release after a failed attempt: from a live claim, one more attempt, a bounded backoff
      IF OLD."fence" IS NULL OR OLD."lease_until" IS NULL OR OLD."lease_until" <= clock_timestamp() THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: only the holder of a live claim gives it back'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."attempts" <> OLD."attempts" + 1 OR NEW."next_attempt_at" IS NULL
         OR NEW."next_attempt_at" < clock_timestamp() - interval '1 second'
         OR NEW."next_attempt_at" > clock_timestamp() + interval '1 day' THEN
        RAISE EXCEPTION 'ck_award_standing_check_transition: a failed attempt counts once and backs off by a bounded time'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- settle: PENDING to DONE, from a live claim, nothing else moved
  IF OLD."fence" IS NULL OR OLD."lease_until" IS NULL OR OLD."lease_until" <= clock_timestamp() THEN
    RAISE EXCEPTION 'ck_award_standing_check_transition: only the holder of a live claim settles a check'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" <> OLD."attempts" OR NEW."next_attempt_at" IS NOT NULL
     OR NEW."lease_until" IS NOT NULL OR NEW."fence" IS NOT NULL
     OR NEW."done_at" > clock_timestamp() + interval '1 second' OR NEW."done_at" < OLD."created_at" THEN
    RAISE EXCEPTION 'ck_award_standing_check_transition: a check is settled once, now, from a live claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A CONFLICT outcome is committed only together with its event: the outbox holds, by the end of the
-- transaction, a TENDER_AWARD_STANDING_CONFLICT_DETECTED for this tender's winning bid. (Deferred, because
-- the service writes the row and then enqueues the event; the runtime role cannot short-cut it.)
CREATE FUNCTION "award_standing_check_conflict_announced"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "outbox_message"
                  WHERE "event_name" = 'TENDER_AWARD_STANDING_CONFLICT_DETECTED'
                    AND "organization_id" = NEW."organization_id"
                    AND "aggregate_id" = NEW."tender_id"
                    AND "payload" #>> '{payload,tenderId}' = NEW."tender_id"
                    AND "payload" #>> '{payload,winningBidId}' = NEW."bid_id") THEN
    RAISE EXCEPTION 'ck_award_standing_check_announced: a conflict is settled only with its event in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_award_standing_check_conflict_announced"
  AFTER UPDATE ON "tender_award_standing_check"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" = 'PENDING' AND NEW."status" = 'DONE' AND NEW."outcome" = 'CONFLICT')
  EXECUTE FUNCTION "award_standing_check_conflict_announced"();

CREATE TRIGGER "tg_award_standing_check_guard"
  BEFORE INSERT OR UPDATE ON "tender_award_standing_check"
  FOR EACH ROW EXECUTE FUNCTION "award_standing_check_guard"();

-- It is evidence that the check was made: never deleted, never truncated.
CREATE TRIGGER "tg_award_standing_check_no_delete"
  BEFORE DELETE ON "tender_award_standing_check"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_award_standing_check_no_truncate"
  BEFORE TRUNCATE ON "tender_award_standing_check"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

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
  -- And with its standing check: an award whose check is not written has nobody to make it.
  IF NOT EXISTS (SELECT 1 FROM "tender_award_standing_check"
                  WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id") THEN
    RAISE EXCEPTION 'ck_award_consistent: an award is committed with its pending standing check'
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
