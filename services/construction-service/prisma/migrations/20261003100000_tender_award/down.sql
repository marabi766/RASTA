-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 10).
--
-- **Refused once any award exists.** An award is the record of who chose which bid, at what
-- rank and amount, and why (ADR-067 § 3); the events that announced it have left the outbox;
-- and the AWARDED and NOT_AWARDED statuses of a tender and its bids are only explained by it.
-- Dropping the table would destroy that, and re-pointing the statuses would rewrite history.
-- Locks the tables first, so no row is written between the check and the drop; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "bid", "tender_award" IN ACCESS EXCLUSIVE MODE;

DO $preflight_award$
DECLARE
  awards bigint;
  tenders bigint;
  bids bigint;
BEGIN
  SELECT count(*) INTO awards FROM "tender_award";
  SELECT count(*) INTO tenders FROM "tender" WHERE "status"::text = 'AWARDED';
  SELECT count(*) INTO bids FROM "bid" WHERE "status"::text IN ('AWARDED', 'NOT_AWARDED');
  IF awards + tenders + bids > 0 THEN
    RAISE EXCEPTION 'down refused: award data exists (% award(s), % awarded tender(s), % awarded or not-awarded bid(s)); dropping it would destroy the record of who chose which bid. Keep this migration.',
      awards, tenders, bids
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_award$;

DROP TRIGGER IF EXISTS "tg_bid_status_requires_award" ON "bid";
DROP FUNCTION IF EXISTS "bid_award_recorded"();

DROP TRIGGER IF EXISTS "tg_tender_status_requires_award" ON "tender";
DROP FUNCTION IF EXISTS "tender_award_recorded"();

DROP TABLE IF EXISTS "tender_award";

DROP FUNCTION IF EXISTS "tender_award_consistent"();
DROP FUNCTION IF EXISTS "tender_award_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261003100000_tender_award';

COMMIT;
