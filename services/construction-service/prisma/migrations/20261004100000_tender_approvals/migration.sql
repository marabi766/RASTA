-- =============================================================================
-- construction-service — approval gates for tender publication, award and cancellation
-- (CON-002 PR 11, docs/24 Q-84 item 5, ADR-063, ADR-065 to ADR-067)
--
-- The approval module (Q-70) gains a second kind of subject: besides a project, an approval can
-- be about one tender. Nothing is duplicated: the policy, its steps, the round and the steps'
-- states are the existing ones (`approval_policy`, `approval_policy_step`, `approval`); a step
-- of a tender round carries the tender's id.
--
-- What is new is the BINDING of a round to the one command it may authorise
-- (`tender_approval_request`): the tender and the version it was asked on and, for an award,
-- the bid, its rank, the justification and the standing read it was decided on; for a
-- cancellation, the reason. And the CONSUMPTION of an approved request by the execution of that
-- command: at most once, in the same transaction as the execution, kept by the database
-- (the runtime role holds DML only and owns nothing, D-045, so it cannot lift these triggers).
-- `tender_approval_log` is the audit row of every request, decision, execution and refusal.
-- =============================================================================

-- ---- approval: a step may be about a tender ------------------------------------------------

ALTER TABLE "approval" ADD COLUMN "tender_id" TEXT;

-- A project's round and a tender's round are numbered independently: one project has many tenders,
-- and each has its own rounds. The two project-scoped indexes gain the tender in their key.
DROP INDEX "ux_approval_round_step";
CREATE UNIQUE INDEX "ux_approval_round_step"
    ON "approval" ("organization_id", "project_id", "workflow_key", COALESCE("tender_id", ''), "round", "step_order");

DROP INDEX "ux_approval_one_pending";
CREATE UNIQUE INDEX "ux_approval_one_pending"
    ON "approval" ("organization_id", "project_id", "workflow_key", COALESCE("tender_id", ''))
 WHERE "status" = 'PENDING';

CREATE INDEX "ix_approval_tender_round"
    ON "approval" ("organization_id", "tender_id", "workflow_key", "round")
 WHERE "tender_id" IS NOT NULL;

ALTER TABLE "approval" ADD CONSTRAINT "approval_organization_id_tender_id_fkey"
  FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A tender workflow's step names its tender, and only a tender workflow's does.
ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_tender_scope"
  CHECK (("workflow_key" LIKE 'tender.%') = ("tender_id" IS NOT NULL));

-- ---- tender_approval_request ---------------------------------------------------------------

CREATE TABLE "tender_approval_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "tender_version" INTEGER NOT NULL,
    "bid_id" TEXT,
    "bidder_organization_id" TEXT,
    "rank" INTEGER,
    "tied" BOOLEAN,
    "justification" TEXT,
    "matrix_digest" TEXT,
    "standing_verdict" TEXT,
    "standing_as_of" TIMESTAMPTZ(3),
    "reason" TEXT,
    "reason_code" TEXT,
    "requested_by" TEXT NOT NULL,
    "requested_by_issuer" TEXT,
    "requested_by_subject" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "requested_correlation_id" TEXT NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_reason" TEXT,
    "consumed_at" TIMESTAMPTZ(3),
    "consumed_by" TEXT,
    "consumed_by_issuer" TEXT,
    "consumed_by_subject" TEXT,
    "consumed_txid" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tender_approval_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_tender_approval_request_round"
    ON "tender_approval_request" ("organization_id", "tender_id", "workflow_key", "round");

-- At most one request of a workflow is alive (undecided or approved and not yet used) per tender ...
CREATE UNIQUE INDEX "ux_tender_approval_request_live"
    ON "tender_approval_request" ("organization_id", "tender_id", "workflow_key")
 WHERE "ended_at" IS NULL AND "consumed_at" IS NULL;

-- ... and at most one is ever consumed: an approval is used once.
CREATE UNIQUE INDEX "ux_tender_approval_request_consumed"
    ON "tender_approval_request" ("organization_id", "tender_id", "workflow_key")
 WHERE "consumed_at" IS NOT NULL;

ALTER TABLE "tender_approval_request" ADD CONSTRAINT "tender_approval_request_organization_id_tender_id_fkey"
  FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tender_approval_request" ADD CONSTRAINT "ck_tender_approval_request_shape"
  CHECK ("workflow_key" IN ('tender.publication', 'tender.award', 'tender.cancellation')
         AND "round" >= 1 AND "tender_version" >= 1 AND "version" >= 1
         AND btrim("requested_by") <> '' AND btrim("requested_correlation_id") <> ''
         AND btrim("project_id") <> '');

-- What each workflow binds: a publication only the tender and its version; an award also the bid, its
-- bidder, its rank, the justification (when the choice is not the single first rank), the digest of the
-- frozen matrix and the standing read; a cancellation the reason in words and its closed code.
ALTER TABLE "tender_approval_request" ADD CONSTRAINT "ck_tender_approval_request_binding"
  CHECK (
    ("workflow_key" = 'tender.publication'
       AND num_nonnulls("bid_id", "bidder_organization_id", "rank", "tied", "justification",
                        "matrix_digest", "standing_verdict", "standing_as_of", "reason", "reason_code") = 0)
    OR ("workflow_key" = 'tender.award'
       AND num_nonnulls("bid_id", "bidder_organization_id", "rank", "tied", "matrix_digest",
                        "standing_verdict", "standing_as_of") = 7
       AND "rank" >= 1 AND "matrix_digest" ~ '^[0-9a-f]{64}$' AND "standing_verdict" = 'ELIGIBLE'
       AND ("justification" IS NULL OR btrim("justification") <> '')
       AND "reason" IS NULL AND "reason_code" IS NULL)
    OR ("workflow_key" = 'tender.cancellation'
       AND "reason" IS NOT NULL AND btrim("reason") <> ''
       AND "reason_code" IN ('OWNER_REQUEST', 'NO_QUALIFIED_BID')
       AND num_nonnulls("bid_id", "bidder_organization_id", "rank", "tied", "justification",
                        "matrix_digest", "standing_verdict", "standing_as_of") = 0)
  );

ALTER TABLE "tender_approval_request" ADD CONSTRAINT "ck_tender_approval_request_end"
  CHECK (("ended_at" IS NULL) = ("ended_reason" IS NULL)
         AND ("ended_reason" IS NULL OR "ended_reason" IN ('REJECTED', 'STALE'))
         AND num_nonnulls("consumed_at", "consumed_by", "consumed_txid") IN (0, 3)
         AND NOT ("ended_at" IS NOT NULL AND "consumed_at" IS NOT NULL)
         AND ("consumed_by" IS NULL OR btrim("consumed_by") <> ''));

-- The requester's and the executor's stable identity (#188): the issuer and the subject together, or neither.
ALTER TABLE "tender_approval_request" ADD CONSTRAINT "ck_tender_approval_request_actor_pair"
  CHECK (num_nonnulls("requested_by_issuer", "requested_by_subject") IN (0, 2)
         AND num_nonnulls("consumed_by_issuer", "consumed_by_subject") IN (0, 2)
         AND ("requested_by_issuer" IS NULL
              OR (btrim("requested_by_issuer") <> '' AND btrim("requested_by_subject") <> ''))
         AND ("consumed_by_issuer" IS NULL
              OR (btrim("consumed_by_issuer") <> '' AND btrim("consumed_by_subject") <> '')));

-- ---- tender_approval_log -------------------------------------------------------------------

-- Every request, decision, execution and refusal on the owner's tender, granted or refused; append-only.
CREATE TABLE "tender_approval_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "request_id" TEXT,
    "workflow_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "refusal_code" TEXT,
    "step_order" INTEGER,
    "actor_user_id" TEXT NOT NULL,
    "actor_organization_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tender_approval_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_tender_approval_log_tender" ON "tender_approval_log" ("organization_id", "tender_id", "occurred_at");

ALTER TABLE "tender_approval_log" ADD CONSTRAINT "tender_approval_log_organization_id_tender_id_fkey"
  FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tender_approval_log" ADD CONSTRAINT "ck_tender_approval_log_shape"
  CHECK ("workflow_key" IN ('tender.publication', 'tender.award', 'tender.cancellation')
         AND "action" IN ('REQUEST', 'GRANT', 'REJECT', 'EXECUTE', 'STALE')
         AND "outcome" IN ('GRANTED', 'REFUSED')
         AND (("outcome" = 'REFUSED') = ("refusal_code" IS NOT NULL))
         AND btrim("actor_user_id") <> '' AND btrim("actor_organization_id") <> ''
         AND ("step_order" IS NULL OR "step_order" >= 1));

CREATE TRIGGER "tg_tender_approval_log_append_only"
  BEFORE UPDATE OR DELETE ON "tender_approval_log"
  FOR EACH ROW EXECUTE FUNCTION "bid_append_only"();
CREATE TRIGGER "tg_tender_approval_log_no_truncate"
  BEFORE TRUNCATE ON "tender_approval_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

-- =============================================================================
-- A request is bound to what it authorises, and the database keeps it to that
-- =============================================================================

-- INSERT: the tender's own project, the tender's CURRENT version and a state the workflow can act on; for
-- an award, a QUALIFIED bid of this tender and its bidder; for a cancellation with NO_QUALIFIED_BID, an
-- EVALUATING tender with no qualified bid. The tender row is taken FOR SHARE first (the owner's commands hold
-- it FOR UPDATE), so the facts judged here cannot move under the insert.
-- UPDATE: what the request is about never changes. It ends once (REJECTED by a refusal of one of its steps,
-- STALE when what it was asked on changed) or is consumed once (every step GRANTED); a consumed or ended
-- request is final. DELETE: never.
CREATE FUNCTION "tender_approval_request_guard"() RETURNS trigger AS $$
DECLARE
  tender_project text;
  tender_version integer;
  tender_status text;
  steps bigint;
  open_steps bigint;
  rejected_steps bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ck_tender_approval_request_final: a tender approval request is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "project_id", "version", "status"::text INTO tender_project, tender_version, tender_status
      FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id"
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_tender_approval_request_tender: the request names no tender of this organization'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."project_id" <> tender_project THEN
      RAISE EXCEPTION 'ck_tender_approval_request_project: a request names the tender''s own project'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."tender_version" <> tender_version THEN
      RAISE EXCEPTION 'ck_tender_approval_request_version: a request is made on the tender''s current version'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."ended_at" IS NOT NULL OR NEW."consumed_at" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_tender_approval_request_new: a request starts alive and unused'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workflow_key" = 'tender.publication' AND tender_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_tender_approval_request_state: only a DRAFT tender is asked to be published'
        USING ERRCODE = 'check_violation';
    ELSIF NEW."workflow_key" = 'tender.award' THEN
      IF tender_status <> 'EVALUATED' OR NOT EXISTS (
           SELECT 1 FROM "bid"
            WHERE "id" = NEW."bid_id" AND "organization_id" = NEW."organization_id"
              AND "tender_id" = NEW."tender_id" AND "status"::text = 'QUALIFIED'
              AND "bidder_organization_id" = NEW."bidder_organization_id") THEN
        RAISE EXCEPTION 'ck_tender_approval_request_state: an award is asked for an EVALUATED tender and one of its QUALIFIED bids'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."workflow_key" = 'tender.cancellation' THEN
      IF tender_status NOT IN ('DRAFT', 'PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED') THEN
        RAISE EXCEPTION 'ck_tender_approval_request_state: only a live tender is asked to be cancelled'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."reason_code" = 'NO_QUALIFIED_BID' AND (
           tender_status <> 'EVALUATING' OR EXISTS (
             SELECT 1 FROM "bid"
              WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
                AND "status"::text = 'QUALIFIED')) THEN
        RAISE EXCEPTION 'ck_tender_approval_request_state: NO_QUALIFIED_BID is for an EVALUATING tender with no qualified bid'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."tender_id" <> OLD."tender_id" OR NEW."project_id" <> OLD."project_id"
     OR NEW."workflow_key" <> OLD."workflow_key" OR NEW."round" <> OLD."round"
     OR NEW."tender_version" <> OLD."tender_version"
     OR NEW."bid_id" IS DISTINCT FROM OLD."bid_id"
     OR NEW."bidder_organization_id" IS DISTINCT FROM OLD."bidder_organization_id"
     OR NEW."rank" IS DISTINCT FROM OLD."rank" OR NEW."tied" IS DISTINCT FROM OLD."tied"
     OR NEW."justification" IS DISTINCT FROM OLD."justification"
     OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
     OR NEW."standing_verdict" IS DISTINCT FROM OLD."standing_verdict"
     OR NEW."standing_as_of" IS DISTINCT FROM OLD."standing_as_of"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code"
     OR NEW."requested_by" <> OLD."requested_by"
     OR NEW."requested_by_issuer" IS DISTINCT FROM OLD."requested_by_issuer"
     OR NEW."requested_by_subject" IS DISTINCT FROM OLD."requested_by_subject"
     OR NEW."requested_at" <> OLD."requested_at"
     OR NEW."requested_correlation_id" <> OLD."requested_correlation_id" THEN
    RAISE EXCEPTION 'ck_tender_approval_request_immutable: what a request authorises never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ended_at" IS NOT NULL OR OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ck_tender_approval_request_final: an ended or consumed request is final'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE "status"::text <> 'GRANTED'),
         count(*) FILTER (WHERE "status"::text = 'REJECTED')
    INTO steps, open_steps, rejected_steps
    FROM "approval"
   WHERE "organization_id" = OLD."organization_id" AND "tender_id" = OLD."tender_id"
     AND "workflow_key" = OLD."workflow_key" AND "round" = OLD."round";

  IF NEW."consumed_at" IS NOT NULL THEN
    -- consumption: an APPROVED request (every step granted), once; the transaction is recorded by the
    -- database itself, so that the execution can be shown to be in the same one.
    IF NEW."ended_at" IS NOT NULL OR steps = 0 OR open_steps > 0 THEN
      RAISE EXCEPTION 'ck_tender_approval_request_consume: only a request with every step granted is used'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."consumed_by" IS NULL THEN
      RAISE EXCEPTION 'ck_tender_approval_request_consume: a request is used by someone'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."consumed_txid" := txid_current();
    NEW."version" := OLD."version" + 1;
    RETURN NEW;
  END IF;

  IF NEW."ended_at" IS NOT NULL THEN
    IF NEW."consumed_by" IS NOT NULL OR NEW."consumed_txid" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_tender_approval_request_end: an ended request is not used'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."ended_reason" = 'REJECTED' AND rejected_steps = 0 THEN
      RAISE EXCEPTION 'ck_tender_approval_request_end: a request is REJECTED only when one of its steps was'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ck_tender_approval_request_final: a request changes only by being used or by ending'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_approval_request_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "tender_approval_request"
  FOR EACH ROW EXECUTE FUNCTION "tender_approval_request_guard"();

CREATE TRIGGER "tg_tender_approval_request_no_truncate"
  BEFORE TRUNCATE ON "tender_approval_request"
  FOR EACH STATEMENT EXECUTE FUNCTION "bid_append_only"();

-- A request commits with its first step: a request nobody can decide is refused.
CREATE FUNCTION "tender_approval_request_has_steps"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "approval"
                  WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
                    AND "workflow_key" = NEW."workflow_key" AND "round" = NEW."round") THEN
    RAISE EXCEPTION 'ck_tender_approval_request_steps: a request commits with the steps that will decide it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_tender_approval_request_has_steps"
  AFTER INSERT ON "tender_approval_request"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "tender_approval_request_has_steps"();

-- A step of a tender round is written only into a round that has its request and is alive, for the tender's
-- own project; and it is GRANTED or REJECTED only while the request is alive (a request that went stale or
-- was refused is not granted afterwards).
CREATE FUNCTION "approval_tender_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_approval_tender_guard"
  BEFORE INSERT OR UPDATE ON "approval"
  FOR EACH ROW
  WHEN (NEW."tender_id" IS NOT NULL)
  EXECUTE FUNCTION "approval_tender_guard"();

-- =============================================================================
-- An approval is used by its execution, in the same transaction, and by nothing else
-- =============================================================================

-- At commit, a request that was used stands only if the tender is in the state the command leaves it in, and
-- on the version the request was made on (the execution moves a tender's version once): what was approved is
-- what was executed. An award is also checked against the award row and the bid the request names.
CREATE FUNCTION "tender_approval_request_executed"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  tender_version integer;
  tender_reason text;
  tender_reason_code text;
BEGIN
  SELECT "status"::text, "version", "status_reason", "status_reason_code"
    INTO tender_status, tender_version, tender_reason, tender_reason_code
    FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id";
  IF tender_version IS DISTINCT FROM NEW."tender_version" + 1 THEN
    RAISE EXCEPTION 'ck_tender_approval_executed: a request is used on the version it was made on'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workflow_key" = 'tender.publication' THEN
    IF tender_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'ck_tender_approval_executed: a used publication request leaves the tender PUBLISHED'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."workflow_key" = 'tender.award' THEN
    IF tender_status IS DISTINCT FROM 'AWARDED' OR NOT EXISTS (
         SELECT 1 FROM "tender_award"
          WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."tender_id"
            AND "bid_id" = NEW."bid_id" AND "awarded_by" = NEW."consumed_by"
            AND "matrix_digest" = NEW."matrix_digest"
            AND "justification" IS NOT DISTINCT FROM NEW."justification"
            AND "rank" = NEW."rank" AND "tied" = NEW."tied") THEN
      RAISE EXCEPTION 'ck_tender_approval_executed: a used award request leaves the tender AWARDED to the bid it names'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF tender_status IS DISTINCT FROM 'CANCELLED'
       OR tender_reason IS DISTINCT FROM NEW."reason"
       OR tender_reason_code IS DISTINCT FROM NEW."reason_code" THEN
      RAISE EXCEPTION 'ck_tender_approval_executed: a used cancellation request leaves the tender CANCELLED for its reason'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_tender_approval_request_executed"
  AFTER UPDATE ON "tender_approval_request"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."consumed_at" IS NULL AND NEW."consumed_at" IS NOT NULL)
  EXECUTE FUNCTION "tender_approval_request_executed"();

-- And the other way round: a tender becomes PUBLISHED, AWARDED or CANCELLED only in a transaction that used
-- the request of that workflow. (The edges into these states are the status guard's; this adds the approval.)
CREATE FUNCTION "tender_status_requires_approval"() RETURNS trigger AS $$
DECLARE
  workflow text;
BEGIN
  workflow := CASE NEW."status"::text
                WHEN 'PUBLISHED' THEN 'tender.publication'
                WHEN 'AWARDED' THEN 'tender.award'
                ELSE 'tender.cancellation'
              END;
  IF NOT EXISTS (SELECT 1 FROM "tender_approval_request"
                  WHERE "organization_id" = NEW."organization_id" AND "tender_id" = NEW."id"
                    AND "workflow_key" = workflow AND "consumed_txid" = txid_current()) THEN
    RAISE EXCEPTION 'ck_tender_status_approved: a tender becomes % only by an approved request used in the same transaction', NEW."status"::text
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_tender_status_requires_approval"
  AFTER UPDATE OF "status" ON "tender"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status"
        AND NEW."status"::text IN ('PUBLISHED', 'AWARDED', 'CANCELLED'))
  EXECUTE FUNCTION "tender_status_requires_approval"();
