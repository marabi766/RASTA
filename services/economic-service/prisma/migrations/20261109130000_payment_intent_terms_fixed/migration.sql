-- A payment intent's terms never change once written, and its lifecycle moves only along the
-- edges the service takes (FU-230; #1017 r1 F1).
--
-- What a payment is (its amount and currency, the wallet and organization it pays, the provider,
-- the key and request it answers, who made it) was enforced by no constraint after the insert, and
-- its lifecycle (`status`, the `failure_reason` markers, the `*_at` instants) is what the service
-- reads as financial evidence: `CAPTURED_NOT_CREDITED` lets a retry credit the wallet,
-- `REFUND_DECLINED_RELEASE_PENDING` returns a refund's hold, `REFUNDED_NOT_REVERSED` reverses the
-- top-up, none of them asking the provider. So:
--
-- `trg_payment_intent_terms_fixed` (before the write, row by row):
-- - an INSERT is born CREATED with nothing done yet: no marker, no instant, no transaction, no
--   provider reference (an INSERT or a COPY cannot plant a later state);
-- - an UPDATE changes nothing but `status`, `failure_reason`, the four instants, `transaction_id`
--   and `provider_reference` (named by what may move, so a column added later is fixed), and
--   moves (status, marker) only along an edge of `edges` below: the nine production writes of
--   `payment.service.ts` / `payment-reconciler.ts`, nothing else. A failure code is any reason but
--   the six markers, and only a FAILED intent carries one. Each edge writes its own columns from
--   NULL to a value (an instant, the capture's transaction, the provider's reference), and every
--   other one stays as it was: nothing is written twice, cleared, or moved back;
-- - DELETE and TRUNCATE: a payment is never erased.
--
-- `trg_payment_intent_evidenced` (deferred to COMMIT, row by row, INSERT and UPDATE) — a
-- financial outcome rests on a record nobody can take back (#1017 r2 F1):
-- - a `transaction_id` names the capture's own transaction (the WALLET_TOP_UP this intent is
--   the source of, in its organization, for its amount and currency), checked on every write;
-- - a marker a reconciliation task tracks (`CAPTURED_REFUND_UNKNOWN`, the four `REFUND_*`) is
--   entered only while the intent has an open task of that kind; `REFUNDED_NOT_REVERSED` and
--   `REFUND_DECLINED_RELEASE_PENDING` only on the provider's answer recorded for that task, and
--   `CAPTURED_NOT_CREDITED` straight from AUTHORIZED only on its recorded decline;
-- - a tracked marker is left only by the transaction that decided its task (a
--   `payment_reconciliation_decision` of this transaction), with a resolution meaning where the
--   intent went, resting on the provider's answer recorded for that task or on an APPROVED
--   operator resolution of it (`payment_reconciliation_resolution`, four-eyes, append-only).
--
-- The records (PM ruling #1017 r3): the database cannot tell a provider's answer from one the
-- runtime role invents, as that role writes whatever the service writes. So nothing that moves
-- money is a state it can set and later unset: each rests on an append-only row, kept with the
-- database's clock, that names the intent, the attempt and the outcome. Forging one leaves it.
-- - `payment_provider_outcome`: what the provider answered (REFUNDED, DECLINED, NOT_REACHED
--   for an absence it vouches for) to one refund attempt (`<key>:refund`, `<key>:uncredited`).
--   Its task (the intent's open one of that kind) and its instant are the database's.
-- - `payment_reconciliation_decision`: how a task finished, and by whom. Inserting it is the only
--   way a task becomes DONE: its trigger runs as the migrator, which alone may write DONE
--   (`trg_payment_reconciliation_task_decided`), and a DONE task never changes after. The runtime
--   role executes no definer function (runtime-forbidden.sql), so the definer is the trigger.
-- Neither is ever updated, deleted or truncated. Still open (follow-up): a runtime-role writer
-- can insert a false answer; only a provider-signed callback closes that.
--
-- Search path (FU-266, #1017 r2 F2): every function here pins its path to the catalogue,
-- temporary relations last (the form `check:utc-clock-sites` admits). One that reads a relation
-- then sets a path local to itself, `pg_catalog, <its trigger table's schema>, pg_temp`
-- (`TG_TABLE_SCHEMA`; restored at its exit by the pin): never the caller's path, no dynamic SQL
-- (the verifier reads no EXECUTE), and the verifier's replay in another schema reads its own.
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION reject_payment_intent_rewrite() RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  moving CONSTANT TEXT[] := ARRAY['status', 'failure_reason', 'authorized_at', 'captured_at',
                                  'failed_at', 'refunded_at', 'transaction_id', 'provider_reference'];
  markers CONSTANT TEXT[] := ARRAY['CAPTURED_NOT_CREDITED', 'CAPTURED_REFUND_UNKNOWN',
                                   'REFUND_REQUESTED', 'REFUND_UNKNOWN', 'REFUNDED_NOT_REVERSED',
                                   'REFUND_DECLINED_RELEASE_PENDING'];
  -- `<status>/<marker>><status>/<marker>` (`*` a failure code, empty no reason), then the columns
  -- that edge writes. Anything not listed is refused.
  edges CONSTANT TEXT[][] := ARRAY[
    ['CREATED/>AUTHORIZED/', 'authorized_at provider_reference'],
    ['CREATED/>FAILED/*', 'failed_at'],
    ['AUTHORIZED/>CAPTURED/', 'captured_at transaction_id'],
    ['AUTHORIZED/>FAILED/*', 'failed_at'],
    ['AUTHORIZED/>AUTHORIZED/CAPTURED_NOT_CREDITED', ''],
    ['AUTHORIZED/>AUTHORIZED/CAPTURED_REFUND_UNKNOWN', ''],
    ['AUTHORIZED/CAPTURED_NOT_CREDITED>CAPTURED/', 'captured_at transaction_id'],
    ['AUTHORIZED/CAPTURED_REFUND_UNKNOWN>FAILED/*', 'failed_at'],
    ['AUTHORIZED/CAPTURED_REFUND_UNKNOWN>AUTHORIZED/CAPTURED_NOT_CREDITED', ''],
    ['CAPTURED/>CAPTURED/REFUND_REQUESTED', ''],
    ['CAPTURED/REFUND_REQUESTED>CAPTURED/REFUND_UNKNOWN', ''],
    ['CAPTURED/REFUND_REQUESTED>CAPTURED/REFUNDED_NOT_REVERSED', ''],
    ['CAPTURED/REFUND_REQUESTED>CAPTURED/REFUND_DECLINED_RELEASE_PENDING', ''],
    ['CAPTURED/REFUND_REQUESTED>REFUNDED/', 'refunded_at'],
    ['CAPTURED/REFUND_UNKNOWN>REFUNDED/', 'refunded_at'],
    ['CAPTURED/REFUNDED_NOT_REVERSED>REFUNDED/', 'refunded_at'],
    ['CAPTURED/REFUND_REQUESTED>CAPTURED/', ''],
    ['CAPTURED/REFUND_UNKNOWN>CAPTURED/', ''],
    ['CAPTURED/REFUND_DECLINED_RELEASE_PENDING>CAPTURED/', '']];
  old_row JSONB;
  new_row JSONB;
  step TEXT;
  writes TEXT;
  col TEXT;
  rewritten BOOLEAN;
BEGIN
  IF TG_OP OPERATOR(pg_catalog.<>) 'UPDATE' AND TG_OP OPERATOR(pg_catalog.<>) 'INSERT' THEN
    RAISE EXCEPTION 'A payment intent is never erased (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  new_row := pg_catalog.to_jsonb(NEW);
  IF TG_OP OPERATOR(pg_catalog.=) 'INSERT' THEN
    IF (new_row OPERATOR(pg_catalog.->>) 'status') OPERATOR(pg_catalog.<>) 'CREATED'
       OR pg_catalog.jsonb_strip_nulls(new_row) OPERATOR(pg_catalog.?|) moving[2:] THEN
      RAISE EXCEPTION 'A payment intent is written CREATED, with nothing done yet'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
    END IF;
    RETURN NEW;
  END IF;
  old_row := pg_catalog.to_jsonb(OLD);
  IF (old_row OPERATOR(pg_catalog.-) moving) OPERATOR(pg_catalog.<>) (new_row OPERATOR(pg_catalog.-) moving) THEN
    RAISE EXCEPTION 'A payment intent''s amount, currency, wallet and terms never change once written'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  step := pg_catalog.concat(OLD."status", '/', CASE WHEN OLD."failure_reason" IS NULL THEN ''
            WHEN OLD."failure_reason" OPERATOR(pg_catalog.=) ANY (markers) THEN OLD."failure_reason"
            ELSE '*' END,
          '>', NEW."status", '/', CASE WHEN NEW."failure_reason" IS NULL THEN ''
            WHEN NEW."failure_reason" OPERATOR(pg_catalog.=) ANY (markers) THEN NEW."failure_reason"
            ELSE '*' END);
  IF pg_catalog.jsonb_build_array(OLD."status", OLD."failure_reason")
     OPERATOR(pg_catalog.=) pg_catalog.jsonb_build_array(NEW."status", NEW."failure_reason") THEN
    writes := ''; -- the same (status, reason): a write of nothing new
  ELSE
    FOR i IN 1 .. pg_catalog.array_length(edges, 1) LOOP
      IF edges[i][1] OPERATOR(pg_catalog.=) step THEN
        writes := edges[i][2];
      END IF;
    END LOOP;
    IF writes IS NULL THEN
      RAISE EXCEPTION 'A payment intent does not move % (its lifecycle moves only forward, along the service''s steps)', step
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
    END IF;
  END IF;
  FOREACH col IN ARRAY moving[3:] LOOP
    -- Its own column goes from NULL to a value; any other stays as it was.
    rewritten := CASE
      WHEN pg_catalog.strpos(pg_catalog.concat(' ', writes, ' '), pg_catalog.concat(' ', col, ' '))
           OPERATOR(pg_catalog.>) 0
      THEN (old_row OPERATOR(pg_catalog.->) col) OPERATOR(pg_catalog.<>) 'null'::JSONB
        OR (new_row OPERATOR(pg_catalog.->) col) OPERATOR(pg_catalog.=) 'null'::JSONB
      ELSE (old_row OPERATOR(pg_catalog.->) col) OPERATOR(pg_catalog.<>) (new_row OPERATOR(pg_catalog.->) col) END;
    IF rewritten THEN
      RAISE EXCEPTION 'A payment intent''s % is written once, by its own step (%), then never changes', col, step
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_intent_terms_fixed"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_intent"
  FOR EACH ROW EXECUTE FUNCTION reject_payment_intent_rewrite();

CREATE TRIGGER "trg_payment_intent_no_truncate"
  BEFORE TRUNCATE ON "payment_intent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_intent_rewrite();


-- What the provider answered to one refund attempt. Never changed: a later answer is a new row.
CREATE TABLE "payment_provider_outcome" (
    "organization_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "kind" "PaymentReconciliationKind" NOT NULL,
    "attempt_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "provider_reference" TEXT,
    "task_id" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_outcome_intent_fkey" FOREIGN KEY ("organization_id", "payment_intent_id")
        REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_provider_outcome_task_fkey" FOREIGN KEY ("organization_id", "task_id")
        REFERENCES "payment_reconciliation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ck_payment_provider_outcome" CHECK ("outcome" IN ('REFUNDED', 'DECLINED', 'NOT_REACHED'))
);

-- The same answer twice (a retried question) is one row; the first instant stands.
CREATE UNIQUE INDEX "ux_payment_provider_outcome" ON "payment_provider_outcome"
    ("organization_id", "payment_intent_id", "attempt_key", "outcome", "task_id") NULLS NOT DISTINCT;

CREATE FUNCTION record_payment_provider_outcome() RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A provider''s answer is kept as it was recorded (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_provider_outcome_kept';
  END IF;
  -- Its relations are its trigger table's schema's, whatever the caller's path (#1017 r2 F2): a
  -- function-local path (restored at exit, by the pin above), with the catalogue first.
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  -- The episode it answers (the intent's open task of that kind, if any) and the instant are the
  -- database's, whatever the writer said.
  NEW."task_id" := (SELECT t.id FROM payment_reconciliation_task t
                     WHERE t.organization_id = NEW."organization_id"
                       AND t.payment_intent_id = NEW."payment_intent_id"
                       AND t.kind = NEW."kind" AND t.status <> 'DONE');
  NEW."recorded_at" := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_provider_outcome_kept"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_provider_outcome"
  FOR EACH ROW EXECUTE FUNCTION record_payment_provider_outcome();

CREATE TRIGGER "trg_payment_provider_outcome_no_truncate"
  BEFORE TRUNCATE ON "payment_provider_outcome"
  FOR EACH STATEMENT EXECUTE FUNCTION record_payment_provider_outcome();

-- How a task finished, and by whom: inserting it finishes the task. Never changed.
CREATE TABLE "payment_reconciliation_decision" (
    "organization_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "last_outcome" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_reconciliation_decision_pkey" PRIMARY KEY ("organization_id", "task_id"),
    CONSTRAINT "payment_reconciliation_decision_task_fkey" FOREIGN KEY ("organization_id", "task_id")
        REFERENCES "payment_reconciliation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "payment_reconciliation_decision_intent_fkey" FOREIGN KEY ("organization_id", "payment_intent_id")
        REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- The definer: runs as the migrator, the one role `trg_payment_reconciliation_task_decided`
-- lets finish a task. A task already finished is not decided again: nothing is inserted.
CREATE FUNCTION finish_payment_reconciliation_task() RETURNS TRIGGER
SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  finished INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A reconciliation decision is kept as it was made (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_reconciliation_decision_kept';
  END IF;
  -- Its relations are its trigger table's schema's, whatever the caller's path (#1017 r2 F2): a
  -- function-local path (restored at exit, by the pin above), with the catalogue first.
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  NEW."decided_at" := (now() AT TIME ZONE 'UTC')::timestamp(3);
  UPDATE payment_reconciliation_task t
     SET status = 'DONE', done_at = NEW."decided_at", updated_at = NEW."decided_at",
         resolution = NEW."resolution", resolved_by = NEW."decided_by",
         last_outcome = coalesce(NEW."last_outcome", t.last_outcome),
         lease_until = NULL, lease_token = NULL
   WHERE t.organization_id = NEW."organization_id" AND t.id = NEW."task_id"
     AND t.payment_intent_id = NEW."payment_intent_id" AND t.status <> 'DONE';
  GET DIAGNOSTICS finished = ROW_COUNT;
  IF finished = 0 THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION finish_payment_reconciliation_task() FROM PUBLIC;

CREATE TRIGGER "trg_payment_reconciliation_decision_kept"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_reconciliation_decision"
  FOR EACH ROW EXECUTE FUNCTION finish_payment_reconciliation_task();

CREATE TRIGGER "trg_payment_reconciliation_decision_no_truncate"
  BEFORE TRUNCATE ON "payment_reconciliation_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION finish_payment_reconciliation_task();

-- DONE is written by the table's owner only (the definer above), and a DONE task never changes:
-- its resolution is no longer the runtime role's to set, or to reset.
CREATE FUNCTION guard_payment_reconciliation_task() RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."status" = 'DONE' OR (TG_OP = 'UPDATE' AND OLD."status" = 'DONE'))
     AND current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION 'A reconciliation task is finished only by its decision (payment_reconciliation_decision), and never changes after'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'trg_payment_reconciliation_task_decided';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_reconciliation_task_decided"
  BEFORE INSERT OR UPDATE ON "payment_reconciliation_task"
  FOR EACH ROW EXECUTE FUNCTION guard_payment_reconciliation_task();

CREATE FUNCTION assert_payment_intent_evidenced() RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tracked CONSTANT text[] := ARRAY['CAPTURED_REFUND_UNKNOWN', 'REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                   'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'];
  was text;
  task_kind text;
  attempt text;
  answered text;
  resolved text[];
  evidenced boolean;
BEGIN
  -- Its relations are its trigger table's schema's, whatever the caller's path (#1017 r2 F2): a
  -- function-local path (restored at exit, by the pin above), with the catalogue first.
  PERFORM set_config('search_path', format('pg_catalog, %I, pg_temp', TG_TABLE_SCHEMA), true);
  IF NEW."transaction_id" IS NOT NULL THEN
    evidenced := EXISTS (SELECT FROM "transaction" t
                          WHERE t.id = NEW."transaction_id" AND t.organization_id = NEW."organization_id"
                            AND t.transaction_type::text = 'WALLET_TOP_UP'
                            AND t.source_type = 'PAYMENT_INTENT' AND t.source_reference = NEW."id"
                            AND t.gross_amount_minor = NEW."amount_minor" AND t.currency = NEW."currency");
    IF NOT evidenced THEN
      RAISE EXCEPTION 'A payment intent names only the transaction its own capture recorded'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NULL;
  END IF;
  was := OLD."failure_reason";
  IF jsonb_build_array(was) = jsonb_build_array(NEW."failure_reason") THEN
    RETURN NULL;
  END IF;
  -- The task kind and refund attempt of the marker entered or left.
  task_kind := CASE WHEN coalesce(was, NEW."failure_reason") IN ('CAPTURED_REFUND_UNKNOWN', 'CAPTURED_NOT_CREDITED')
               THEN 'UNCREDITED_REFUND' ELSE 'REFUND' END;
  attempt := concat(NEW."idempotency_key", CASE WHEN task_kind = 'REFUND' THEN ':refund' ELSE ':uncredited' END);

  IF NEW."failure_reason" = ANY (tracked) THEN
    -- Entered: a task of its kind is open; a known outcome also rests on that task's answer.
    answered := CASE NEW."failure_reason" WHEN 'REFUNDED_NOT_REVERSED' THEN 'REFUNDED'
                WHEN 'REFUND_DECLINED_RELEASE_PENDING' THEN 'DECLINED' END;
    evidenced := EXISTS (SELECT FROM payment_reconciliation_task t
                          WHERE t.organization_id = NEW."organization_id" AND t.payment_intent_id = NEW."id"
                            AND t.kind::text = task_kind AND t.status <> 'DONE'
                            AND (answered IS NULL OR EXISTS (
                              SELECT FROM payment_provider_outcome o
                               WHERE o.organization_id = t.organization_id
                                 AND o.payment_intent_id = t.payment_intent_id AND o.task_id = t.id
                                 AND o.attempt_key = attempt AND o.outcome = answered)));
    IF NOT evidenced THEN
      RAISE EXCEPTION 'A payment intent is marked % only while a reconciliation task is open on it, on the provider''s recorded answer', NEW."failure_reason"
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  ELSIF was IS NULL AND NEW."failure_reason" = 'CAPTURED_NOT_CREDITED' THEN
    -- Creditable straight from AUTHORIZED: the provider declined returning the capture.
    evidenced := EXISTS (SELECT FROM payment_provider_outcome o
                          WHERE o.organization_id = NEW."organization_id" AND o.payment_intent_id = NEW."id"
                            AND o.attempt_key = attempt AND o.outcome = 'DECLINED');
    IF NOT evidenced THEN
      RAISE EXCEPTION 'A payment intent is CAPTURED_NOT_CREDITED only on the provider''s recorded decline of returning it'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  ELSIF was = ANY (tracked) THEN
    -- Left: by the transaction that decided its task (xmin, and the instant it began: an id
    -- reused after a restore or a wraparound does not share it), on that task's recorded answer
    -- or its approved operator resolution, which says where the intent went.
    resolved := CASE NEW."status"::text
      WHEN 'REFUNDED' THEN ARRAY['REFUNDED']
      WHEN 'CAPTURED' THEN ARRAY['REFUND_DECLINED', 'REFUND_NOT_REACHED']
      WHEN 'FAILED' THEN ARRAY['UNCREDITED_REFUNDED']
      WHEN 'AUTHORIZED' THEN ARRAY['UNCREDITED_DECLINED', 'UNCREDITED_NOT_REACHED'] END;
    evidenced := EXISTS (
      SELECT FROM payment_reconciliation_decision d
        JOIN payment_reconciliation_task t ON t.organization_id = d.organization_id AND t.id = d.task_id
       WHERE d.organization_id = NEW."organization_id" AND d.payment_intent_id = NEW."id"
         AND t.kind::text = task_kind AND d.resolution = ANY (resolved)
         AND d.xmin = xid(pg_current_xact_id())
         AND d.decided_at = (now() AT TIME ZONE 'UTC')::timestamp(3)
         AND (EXISTS (SELECT FROM payment_provider_outcome o
                       WHERE o.organization_id = d.organization_id
                         AND o.payment_intent_id = d.payment_intent_id
                         AND o.task_id = d.task_id AND o.attempt_key = attempt
                         AND o.outcome = regexp_replace(d.resolution, '^(UNCREDITED|REFUND)_', ''))
           OR EXISTS (SELECT FROM payment_reconciliation_resolution r
                       WHERE r.organization_id = d.organization_id AND r.task_id = d.task_id
                         AND r.payment_intent_id = d.payment_intent_id
                         AND r.status::text = 'APPROVED'
                         AND r.provider_outcome::text = regexp_replace(d.resolution, '^(UNCREDITED|REFUND)_', ''))));
    IF NOT evidenced THEN
      RAISE EXCEPTION 'A payment intent leaves % only as its reconciliation task is decided on the provider''s recorded answer or an approved resolution', was
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_payment_intent_evidenced"
  AFTER INSERT OR UPDATE ON "payment_intent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_intent_evidenced();
