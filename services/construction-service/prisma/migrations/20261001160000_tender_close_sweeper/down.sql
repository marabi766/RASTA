-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 7).
--
-- **Refused while any tender records its closure.** `closed_at` / `closed_by` are the
-- only record of when and by whom a tender stopped taking bids, and the event that
-- announced it has left the outbox; dropping the columns would destroy that fact.
-- A lease alone is disposable (it only says a sweeper was about to close the tender).
-- Locks the tender table first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender" IN ACCESS EXCLUSIVE MODE;

DO $preflight_closure$
DECLARE
  closed bigint;
BEGIN
  SELECT count(*) INTO closed FROM "tender" WHERE "closed_at" IS NOT NULL;
  IF closed > 0 THEN
    RAISE EXCEPTION 'down refused: % tender(s) record when and by whom they were closed; dropping the columns would destroy that. Keep this migration.', closed
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_closure$;

DROP TRIGGER IF EXISTS "tg_tender_leave_published_clears_close_claim" ON "tender";
DROP FUNCTION IF EXISTS "tender_leave_published_clears_close_claim"();
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_close_attempts";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_close_lease";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_closure_complete";
DROP INDEX IF EXISTS "ix_tender_close_due";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "close_next_attempt_at";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "close_attempts";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "close_fence";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "close_lease_until";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "closed_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "closed_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001160000_tender_close_sweeper';

COMMIT;
