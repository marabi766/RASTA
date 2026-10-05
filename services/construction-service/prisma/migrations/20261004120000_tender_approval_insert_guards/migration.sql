-- =============================================================================
-- construction-service — the insert gaps of the tender approval guards (CON-002 PR 11, review round 1)
--
-- `20261004100000_tender_approvals` kept a tender's STATUS UPDATES behind an approved request, but the runtime
-- role also holds INSERT: a row inserted already PUBLISHED, AWARDED or CANCELLED never passed through an
-- update. And a step of a tender round could be INSERTED already GRANTED, or moved by an UPDATE that skipped
-- the states, or by the person who made the request. This closes them where the rows are written.
-- =============================================================================

-- ---- a tender is inserted only as a DRAFT --------------------------------------------------------------------

CREATE FUNCTION "tender_insert_draft_only"() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text <> 'DRAFT' THEN
    RAISE EXCEPTION 'ck_tender_insert_draft: a tender is inserted as a DRAFT; it is published, awarded or cancelled only by an approved request used in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_insert_draft_only"
  BEFORE INSERT ON "tender"
  FOR EACH ROW EXECUTE FUNCTION "tender_insert_draft_only"();

-- ---- a step of a tender round: written asked, moved only along the states, granted only in its turn ---------------

-- INSERT: a step starts PENDING or QUEUED, in a round whose request is alive, for the tender's own project.
-- UPDATE: what the step is (its tender, workflow, round, order, authority, policy) never changes; its status
-- moves only along QUEUED → PENDING | SUPERSEDED and PENDING → GRANTED | REJECTED | SUPERSEDED, only while the
-- request is alive, and a GRANT is by someone other than the person who made the request and only when every
-- earlier step of the round is granted. (That the grantor is a different PERSON, not only a different user id,
-- is the service's: the database holds no identity beyond what the request recorded.)
CREATE OR REPLACE FUNCTION "approval_tender_guard"() RETURNS trigger AS $$
DECLARE
  request_project text;
  request_ended timestamptz;
  request_consumed timestamptz;
  request_by text;
BEGIN
  SELECT "project_id", "ended_at", "consumed_at", "requested_by"
    INTO request_project, request_ended, request_consumed, request_by
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
    IF NEW."status"::text NOT IN ('PENDING', 'QUEUED') THEN
      RAISE EXCEPTION 'ck_approval_tender_new: a step of a tender round starts PENDING or QUEUED, never decided'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW."tender_id" IS DISTINCT FROM OLD."tender_id" OR NEW."workflow_key" <> OLD."workflow_key"
     OR NEW."round" <> OLD."round" OR NEW."step_order" <> OLD."step_order"
     OR NEW."project_id" <> OLD."project_id" OR NEW."policy_id" <> OLD."policy_id"
     OR NEW."authority_organization_id" <> OLD."authority_organization_id"
     OR NEW."authority_role" <> OLD."authority_role" THEN
    RAISE EXCEPTION 'ck_approval_tender_immutable: what a step of a tender round is, and who decides it, never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status"::text <> OLD."status"::text THEN
    IF NOT ((OLD."status"::text = 'QUEUED' AND NEW."status"::text IN ('PENDING', 'SUPERSEDED'))
         OR (OLD."status"::text = 'PENDING' AND NEW."status"::text IN ('GRANTED', 'REJECTED', 'SUPERSEDED'))) THEN
      RAISE EXCEPTION 'ck_approval_tender_transition: a step of a tender round moves only along its states'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status"::text IN ('GRANTED', 'REJECTED') THEN
      IF request_ended IS NOT NULL OR request_consumed IS NOT NULL THEN
        RAISE EXCEPTION 'ck_approval_tender_request: a step is decided only while its request is alive'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."status"::text = 'GRANTED' THEN
      IF NEW."decided_by" IS NOT DISTINCT FROM request_by THEN
        RAISE EXCEPTION 'ck_approval_tender_grantor: the person who made a request does not grant it'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "approval" a
                  WHERE a."organization_id" = NEW."organization_id" AND a."tender_id" = NEW."tender_id"
                    AND a."workflow_key" = NEW."workflow_key" AND a."round" = NEW."round"
                    AND a."step_order" < NEW."step_order" AND a."status"::text <> 'GRANTED') THEN
        RAISE EXCEPTION 'ck_approval_tender_order: a step is granted only after every earlier step of its round'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- the log also records a refused read of an award approval --------------------------------------------------------

ALTER TABLE "tender_approval_log" DROP CONSTRAINT "ck_tender_approval_log_shape";
ALTER TABLE "tender_approval_log" ADD CONSTRAINT "ck_tender_approval_log_shape"
  CHECK ("workflow_key" IN ('tender.publication', 'tender.award', 'tender.cancellation')
         AND "action" IN ('REQUEST', 'GRANT', 'REJECT', 'EXECUTE', 'STALE', 'READ')
         AND "outcome" IN ('GRANTED', 'REFUSED')
         AND (("outcome" = 'REFUSED') = ("refusal_code" IS NOT NULL))
         AND btrim("actor_user_id") <> '' AND btrim("actor_organization_id") <> ''
         AND ("step_order" IS NULL OR "step_order" >= 1));
