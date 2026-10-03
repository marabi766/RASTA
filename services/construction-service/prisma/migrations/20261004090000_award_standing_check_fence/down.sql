-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 11 carry-over): the guard as 20261003100000_tender_award wrote it.
--
-- Not refused when standing checks exist: it only relaxes one condition of a claim. The
-- `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender_award_standing_check" IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION "award_standing_check_guard"() RETURNS trigger AS $$
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

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004090000_award_standing_check_fence';

COMMIT;
