-- =============================================================================
-- Reverse of `migration.sql` (20261006160000_review_detection_provenance, CON-003 PR 2 round 6).
--
-- **Refuses, and changes nothing, once any review the older schema could not hold exists.** The
-- previous schema required every review to name its cause event and instant; a review that was
-- detected without a proven cause (`MOVE_RECHECK`) has neither, and inventing one would be exactly
-- the false attribution this migration removed. So this script stops, with a message, when any
-- review has no cause event. On a database where none exists it restores the previous schema
-- exactly (the `detected_by` of the rows that remain is dropped: all were `ORGANIZATION_MOVED`).
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check and every change commit together or
-- not at all, run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it.
-- =============================================================================

BEGIN;

LOCK TABLE "signature_authority_review" IN ACCESS EXCLUSIVE MODE;

DO $preflight_detection$
DECLARE
  unattributed integer;
BEGIN
  SELECT count(*) INTO unattributed FROM "signature_authority_review"
   WHERE "cause_event_id" IS NULL OR "moved_at" IS NULL OR "detected_by" <> 'ORGANIZATION_MOVED';
  IF unattributed > 0 THEN
    RAISE EXCEPTION 'down refused: % review(s) were detected without a proven cause event; nothing was changed', unattributed
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_detection$;

ALTER TABLE "signature_authority_review" DROP CONSTRAINT IF EXISTS "ck_review_detection";
ALTER TABLE "signature_authority_review" DROP CONSTRAINT IF EXISTS "ck_review_reason";
ALTER TABLE "signature_authority_review" ADD CONSTRAINT "ck_review_reason"
  CHECK ("reason" = 'AUTHORITY_CHANGED_DURING_SIGNING'
         AND "side" = 'EMPLOYER'
         AND btrim("cause_event_id") <> '');

ALTER TABLE "signature_authority_review"
  DROP COLUMN IF EXISTS "detected_by",
  ALTER COLUMN "moved_at" SET NOT NULL,
  ALTER COLUMN "cause_event_id" SET NOT NULL;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006160000_review_detection_provenance';

COMMIT;
