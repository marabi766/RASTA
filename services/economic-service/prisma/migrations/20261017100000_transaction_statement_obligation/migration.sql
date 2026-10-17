-- A contract statement's obligation (ADR-068 § 6 (2), CON-003 PR 6b).
--
-- economic-service records it from STATEMENT_APPROVED, with the amount, the
-- payer and the beneficiary read from contract-service, under the key
-- (organization_id, 'STATEMENT', statement id) that ux_transaction_source_fact
-- already makes unique. Two things that key alone does not hold:
--
-- 1. Who writes such a row. POST /v1/transactions lets a caller choose
--    source_type freely; a row it wrote under STATEMENT/<id> first would hold
--    the key, and the real approval would find it — with the caller's amount —
--    and record nothing. The API refuses the source type; this CHECK refuses
--    it at the database too: a STATEMENT row is a CONSTRUCTION_STATEMENT
--    obligation to a payee, written by economic-service from an event (a
--    causation id, no Idempotency-Key).
--
-- 2. That it never changes (ADR-068 § 6 (5) I3/I4: the statement is immutable
--    once approved, so its obligation is too). The trigger refuses any change
--    to the terms — parties, type, line, amount, currency, instant, source,
--    author, causation — and any DELETE: a deleted obligation would let a
--    replay record a second one. The lifecycle (status, settlement, dispute,
--    cancellation columns) moves as for any obligation; pricing is already
--    fixed by trg_transaction_pricing_fixed.
--
-- Populated databases. A STATEMENT row can already exist in two ways, and
-- only one of them is an obligation:
--
-- - recorded by the STATEMENT_APPROVED consumer, when this migration was
--   applied, rolled back by down.sql (which keeps every row) and is applied
--   again. Such a row is provably the consumer's: its causation_id is an
--   event the consumer marked processed in the same transaction —
--   processed_event under 'economic-service.statement-settlement'
--   (StatementSettlementConsumer.CONSUMER_NAME), which nothing deletes.
--   POST /v1/transactions never writes a causation id nor that marker, in
--   this release or any earlier one. Accepted as it is; the CHECK below still
--   holds it to the consumer's shape.
-- - written through POST /v1/transactions, by a release that did not reserve
--   the source type (any before this one, or the previous release during a
--   rollback). Not an approval's obligation, and it holds the key the real
--   approval needs. Counted and refused loudly, with nothing changed: what
--   happens to it is a financial decision for a person (the HINT).
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
    FROM "transaction" t
   WHERE t."source_type" = 'STATEMENT'
     AND NOT EXISTS (
       SELECT 1
         FROM "processed_event" p
        WHERE p."event_id" = t."causation_id"
          AND p."consumer_name" = 'economic-service.statement-settlement'
     );

  IF offending > 0 THEN
    RAISE EXCEPTION
      'transaction: % row(s) carry source_type STATEMENT without being recorded by the STATEMENT_APPROVED consumer; refusing to reserve it',
      offending
      USING HINT = 'List them with: SELECT id, organization_id, source_reference, status, created_by, idempotency_key, causation_id FROM "transaction" t WHERE source_type = ''STATEMENT'' AND NOT EXISTS (SELECT 1 FROM processed_event p WHERE p.event_id = t.causation_id AND p.consumer_name = ''economic-service.statement-settlement''); none is an approved statement''s obligation. For each, record the financial decision on it under the release now running (cancel or refund it if nobody owes it), then take it off the reserved type by a reviewed data correction recorded with that decision: UPDATE "transaction" SET source_type = ''STATEMENT_UNCONFIRMED'' WHERE id = <id>. Never DELETE it.';
  END IF;
END $$;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_statement_obligation" CHECK (
    "source_type" IS DISTINCT FROM 'STATEMENT'
    OR (
      "transaction_type" = 'CONSTRUCTION_STATEMENT'
      AND "source_reference" IS NOT NULL
      AND "counterparty_organization_id" IS NOT NULL
      AND "idempotency_key" IS NULL
      AND "causation_id" IS NOT NULL
      AND "created_by" = 'economic-service'
    )
  );

CREATE OR REPLACE FUNCTION reject_statement_obligation_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transaction %: a statement obligation is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."source_type" IS DISTINCT FROM NEW."source_type"
     OR OLD."source_reference" IS DISTINCT FROM NEW."source_reference"
     OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
     OR OLD."counterparty_organization_id" IS DISTINCT FROM NEW."counterparty_organization_id"
     OR OLD."transaction_type" IS DISTINCT FROM NEW."transaction_type"
     OR OLD."business_line" IS DISTINCT FROM NEW."business_line"
     OR OLD."gross_amount_minor" IS DISTINCT FROM NEW."gross_amount_minor"
     OR OLD."currency" IS DISTINCT FROM NEW."currency"
     OR OLD."occurred_at" IS DISTINCT FROM NEW."occurred_at"
     OR OLD."created_by" IS DISTINCT FROM NEW."created_by"
     OR OLD."causation_id" IS DISTINCT FROM NEW."causation_id"
     OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key" THEN
    RAISE EXCEPTION 'transaction %: the terms of a statement obligation never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- For a STATEMENT row. An UPDATE that would turn another row into one is
-- held by the CHECK above (no other row is an event-recorded
-- CONSTRUCTION_STATEMENT obligation).
CREATE TRIGGER "trg_transaction_statement_obligation_fixed"
  BEFORE UPDATE OR DELETE ON "transaction"
  FOR EACH ROW
  WHEN (OLD."source_type" = 'STATEMENT')
  EXECUTE FUNCTION reject_statement_obligation_change();
