-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 11, review round 1): the guards as `20261004100000_tender_approvals`
-- wrote them.
--
-- Not refused when tender approvals exist: it only relaxes guards (an insert as another status, the order and
-- the shape of a step's moves) and forgets no record. A log row that says READ is refused instead, since the
-- older constraint does not know the word: the preflight names it. Locks the tables first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "approval", "tender_approval_log" IN ACCESS EXCLUSIVE MODE;

DO $preflight_insert_guards$
DECLARE
  reads bigint;
BEGIN
  SELECT count(*) INTO reads FROM "tender_approval_log" WHERE "action" = 'READ';
  IF reads > 0 THEN
    RAISE EXCEPTION 'down refused: % refused read(s) of an award approval are logged; the older log constraint cannot hold them. Keep this migration.', reads
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_insert_guards$;

ALTER TABLE "tender_approval_log" DROP CONSTRAINT "ck_tender_approval_log_shape";
ALTER TABLE "tender_approval_log" ADD CONSTRAINT "ck_tender_approval_log_shape"
  CHECK ("workflow_key" IN ('tender.publication', 'tender.award', 'tender.cancellation')
         AND "action" IN ('REQUEST', 'GRANT', 'REJECT', 'EXECUTE', 'STALE')
         AND "outcome" IN ('GRANTED', 'REFUSED')
         AND (("outcome" = 'REFUSED') = ("refusal_code" IS NOT NULL))
         AND btrim("actor_user_id") <> '' AND btrim("actor_organization_id") <> ''
         AND ("step_order" IS NULL OR "step_order" >= 1));

CREATE OR REPLACE FUNCTION "approval_tender_guard"() RETURNS trigger AS $$
DECLARE
  request_project text;
  request_ended timestamptz;
  request_consumed timestamptz;
BEGIN
  SELECT "project_id", "ended_at", "consumed_at" INTO request_project, request_ended, request_consumed
    FROM "tender_approval_request"
   WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
     AND "workflow_key" = NEW."workflow_key" AND "round" = NEW."round";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ck_approval_tender_request: a step of a tender round belongs to a request'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."project_id" <> request_project THEN
    RAISE EXCEPTION 'ck_approval_tender_project: a step of a tender round names the tender''s own project'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF request_ended IS NOT NULL OR request_consumed IS NOT NULL THEN
      RAISE EXCEPTION 'ck_approval_tender_request: steps are added to a request that is alive'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status"::text IN ('GRANTED', 'REJECTED') AND OLD."status"::text <> NEW."status"::text THEN
    IF request_ended IS NOT NULL OR request_consumed IS NOT NULL THEN
      RAISE EXCEPTION 'ck_approval_tender_request: a step is decided only while its request is alive'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tg_tender_insert_draft_only" ON "tender";
DROP FUNCTION IF EXISTS "tender_insert_draft_only"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004120000_tender_approval_insert_guards';

COMMIT;
