-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 8).
--
-- **Refused while any tender records its opening or a pending proposal to open.**
-- `opened_at` / `opened_by` are the only record of when and by whom the bids were opened,
-- and the event that announced it has left the outbox; `opening_proposed_*` is the first
-- of the two people of a four-eyes opening, who has proposed and is waiting for the second.
-- Dropping either would destroy that fact (a proposal would vanish without a trace).
-- Locks the tender table first, so none is written between the check and the drop; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender" IN ACCESS EXCLUSIVE MODE;

DO $preflight_opening$
DECLARE
  opened bigint;
  proposed bigint;
BEGIN
  SELECT count(*) INTO opened FROM "tender"
   WHERE "opened_at" IS NOT NULL OR "opened_by" IS NOT NULL;
  SELECT count(*) INTO proposed FROM "tender"
   WHERE ("opening_proposed_at" IS NOT NULL OR "opening_proposed_by" IS NOT NULL)
     AND "opened_at" IS NULL;
  IF proposed > 0 THEN
    RAISE EXCEPTION 'down refused: % tender(s) hold a pending proposal to open their bids; dropping the columns would silently discard it. Keep this migration.', proposed
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF opened > 0 THEN
    RAISE EXCEPTION 'down refused: % tender(s) record when and by whom their bids were opened; dropping the columns would destroy that. Keep this migration.', opened
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_opening$;

ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_opening_proposal_complete";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opening_proposed_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opening_proposed_at";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_opening_complete";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opened_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "opened_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002100000_tender_open_bids';

COMMIT;
