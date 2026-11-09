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
-- `trg_payment_intent_evidenced` (deferred to COMMIT, row by row, INSERT and UPDATE):
-- - a `transaction_id` names the capture's own transaction: the WALLET_TOP_UP this intent is the
--   source of (`source_type` PAYMENT_INTENT, `source_reference` its id), in its organization, for
--   its amount and currency;
-- - a marker a reconciliation task tracks (`CAPTURED_REFUND_UNKNOWN` for an AUTHORIZED intent, the
--   four `REFUND_*` for a CAPTURED one) is entered only while the intent has an open task of that
--   kind, and left only by the transaction that finishes that task with a resolution meaning where
--   the intent went (REFUNDED; REFUND_DECLINED or REFUND_NOT_REACHED back to CAPTURED;
--   UNCREDITED_REFUNDED to FAILED; UNCREDITED_DECLINED or UNCREDITED_NOT_REACHED to creditable).
--   Every writer that leaves one closes or finishes the task in the same transaction already.
--
-- Search path (FU-266): the row rule reads no relation and pins its path to the catalogue,
-- temporary relations last (the form `check:utc-clock-sites` admits). The evidence reads two
-- tables of this schema, which the verifier replays in another one, so it cannot name its schema:
-- it names every built-in function and operator by `pg_catalog` instead, and compares no value
-- through an operator it does not name (no `IS DISTINCT FROM`). The runtime role has no TEMP.
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

CREATE FUNCTION assert_payment_intent_evidenced() RETURNS TRIGGER AS $$
DECLARE
  tracked CONSTANT pg_catalog.text[] := ARRAY['CAPTURED_REFUND_UNKNOWN', 'REFUND_REQUESTED',
    'REFUND_UNKNOWN', 'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING']::pg_catalog.text[];
  was pg_catalog.text := OLD."failure_reason";
  task_kind pg_catalog.text;
  resolved pg_catalog.text[];
BEGIN
  IF NEW."transaction_id" IS NOT NULL
     AND (TG_OP OPERATOR(pg_catalog.=) 'INSERT' OR OLD."transaction_id" IS NULL
          OR OLD."transaction_id" OPERATOR(pg_catalog.<>) NEW."transaction_id")
     AND NOT EXISTS (
       SELECT FROM "transaction" t
        WHERE t."id" OPERATOR(pg_catalog.=) NEW."transaction_id"
          AND t."organization_id" OPERATOR(pg_catalog.=) NEW."organization_id"
          AND t."transaction_type"::pg_catalog.text OPERATOR(pg_catalog.=) 'WALLET_TOP_UP'
          AND t."source_type" OPERATOR(pg_catalog.=) 'PAYMENT_INTENT'
          AND t."source_reference" OPERATOR(pg_catalog.=) NEW."id"
          AND t."gross_amount_minor" OPERATOR(pg_catalog.=) NEW."amount_minor"
          AND t."currency" OPERATOR(pg_catalog.=) NEW."currency") THEN
    RAISE EXCEPTION 'A payment intent names only the transaction its own capture recorded'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
  END IF;
  IF TG_OP OPERATOR(pg_catalog.=) 'INSERT'
     OR pg_catalog.jsonb_build_array(was)
        OPERATOR(pg_catalog.=) pg_catalog.jsonb_build_array(NEW."failure_reason") THEN
    RETURN NULL;
  END IF;
  IF NEW."failure_reason" OPERATOR(pg_catalog.=) ANY (tracked) THEN
    -- Entered: a task of its kind is open on the intent.
    task_kind := CASE WHEN NEW."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'AUTHORIZED'
                 THEN 'UNCREDITED_REFUND' ELSE 'REFUND' END;
    IF NOT EXISTS (
      SELECT FROM payment_reconciliation_task t
       WHERE t."organization_id" OPERATOR(pg_catalog.=) NEW."organization_id"
         AND t."payment_intent_id" OPERATOR(pg_catalog.=) NEW."id"
         AND t."kind"::pg_catalog.text OPERATOR(pg_catalog.=) task_kind
         AND t."status"::pg_catalog.text OPERATOR(pg_catalog.<>) 'DONE') THEN
      RAISE EXCEPTION 'A payment intent is marked % only while a reconciliation task is open on it', NEW."failure_reason"
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  ELSIF was OPERATOR(pg_catalog.=) ANY (tracked) THEN
    -- Left: by the transaction that finished its task, with the outcome the intent moved to.
    task_kind := CASE WHEN OLD."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'AUTHORIZED'
                 THEN 'UNCREDITED_REFUND' ELSE 'REFUND' END;
    resolved := CASE
      WHEN NEW."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'REFUNDED' THEN ARRAY['REFUNDED']
      WHEN NEW."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'CAPTURED'
        THEN ARRAY['REFUND_DECLINED', 'REFUND_NOT_REACHED']
      WHEN NEW."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'FAILED' THEN ARRAY['UNCREDITED_REFUNDED']
      WHEN NEW."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'AUTHORIZED'
        THEN ARRAY['UNCREDITED_DECLINED', 'UNCREDITED_NOT_REACHED'] END::pg_catalog.text[];
    IF NOT EXISTS (
      SELECT FROM payment_reconciliation_task t
       WHERE t."organization_id" OPERATOR(pg_catalog.=) NEW."organization_id"
         AND t."payment_intent_id" OPERATOR(pg_catalog.=) NEW."id"
         AND t."kind"::pg_catalog.text OPERATOR(pg_catalog.=) task_kind
         AND t."status"::pg_catalog.text OPERATOR(pg_catalog.=) 'DONE'
         AND t."resolution" OPERATOR(pg_catalog.=) ANY (resolved)
         AND t."xmin" OPERATOR(pg_catalog.=) pg_catalog.xid(pg_catalog.pg_current_xact_id())) THEN
      RAISE EXCEPTION 'A payment intent leaves % only as its reconciliation task is finished with that outcome', was
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_evidenced';
    END IF;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_payment_intent_evidenced"
  AFTER INSERT OR UPDATE ON "payment_intent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_intent_evidenced();
