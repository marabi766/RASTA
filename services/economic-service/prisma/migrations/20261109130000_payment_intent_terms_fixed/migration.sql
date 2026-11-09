-- A payment intent's terms never change once written (FU-230).
--
-- What a payment is (its amount and currency, the wallet and organization it pays, the provider,
-- the key and request it answers, who made it) was enforced by no constraint after the insert: any
-- UPDATE could rewrite it, and a hold funded by a refund (`wallet_hold_funded`) or a reconciliation
-- reads it as it stands then. So `trg_payment_intent_terms_fixed` refuses, before the write:
--
-- - any change to a column other than the lifecycle ones: `status`, `failure_reason` and the
--   `*_at` instants of the steps. Named by what may move, not by what may not, so a column added
--   later is fixed until a migration says otherwise;
-- - a second write of `transaction_id` (the transaction a capture funds) or `provider_reference`
--   (the provider's own id): each is written once, from NULL, and then never changes or is erased;
--   and `transaction_id` only by the write that captures (`payment.service.ts`, the one writer);
-- - DELETE and TRUNCATE: a payment is never erased.
--
-- The status transitions stay the service's (`payment.service.ts`), and none of its writes moves
-- anything else. The function reads no relation and names every built-in function and operator by
-- `pg_catalog`, so the path decides nothing it does (the FU-266 rule). A `SET search_path` on it
-- would be refused by `check:utc-clock-sites` (a session setting that may move names).
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION reject_payment_intent_rewrite() RETURNS TRIGGER AS $$
DECLARE
  lifecycle CONSTANT TEXT[] := ARRAY['status', 'failure_reason', 'authorized_at', 'captured_at',
                                     'failed_at', 'refunded_at'];
  written_once CONSTANT TEXT[] := ARRAY['transaction_id', 'provider_reference'];
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'A payment intent is never erased (% refused)', TG_OP
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  IF ((pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-) lifecycle) OPERATOR(pg_catalog.-) written_once)
     IS DISTINCT FROM
     ((pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-) lifecycle) OPERATOR(pg_catalog.-) written_once) THEN
    RAISE EXCEPTION 'A payment intent''s amount, currency, wallet and terms never change once written'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  IF (OLD."transaction_id" IS NOT NULL AND NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id")
     OR (OLD."provider_reference" IS NOT NULL
         AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference") THEN
    RAISE EXCEPTION 'A payment intent''s transaction and provider reference are written once, then never change'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  IF OLD."transaction_id" IS NULL AND NEW."transaction_id" IS NOT NULL AND NEW."status"::TEXT OPERATOR(pg_catalog.<>) 'CAPTURED' THEN
    RAISE EXCEPTION 'A payment intent names the transaction it funds only as it is captured'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_payment_intent_terms_fixed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_intent_terms_fixed"
  BEFORE UPDATE OR DELETE ON "payment_intent"
  FOR EACH ROW EXECUTE FUNCTION reject_payment_intent_rewrite();

CREATE TRIGGER "trg_payment_intent_no_truncate"
  BEFORE TRUNCATE ON "payment_intent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_intent_rewrite();
