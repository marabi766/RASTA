-- =============================================================================
-- marketplace-service — where a dispute found its order (marketplace audit F1, PM decision
-- D-083).
--
-- An operator's SETTLE used to move every disputed order to RECEIPT_CONFIRMED. A buyer may
-- dispute before confirming receipt (FUNDS_HELD, CONFIRMED, AWAITING_RECEIPT_CONFIRMATION), and
-- the order then claimed a receipt nobody confirmed: no `receipt_confirmed_at`/`_by`, the saga
-- authorised settlement, and `ck_order_settled_after_receipt` refused `SETTLING` — money
-- authorised, order stuck. Now SETTLE resumes the order where its dispute found it, and only a
-- dispute raised after receipt returns to RECEIPT_CONFIRMED. That needs the status the order had
-- when the dispute was raised, recorded on the dispute.
--
-- ## Recorded by the database, for every writer
--
-- `raised_from_status` is assigned by a trigger from the order's own row as the dispute is
-- inserted — the user's dispute and the one the saga files for economic-service alike, and a
-- pod of the previous release that does not know the column. Both writers insert the dispute
-- under the order's row lock, before they move the order to DISPUTED, so the row holds the status
-- the dispute interrupted. A write can neither set nor change it afterwards. The CHECK admits only
-- the four statuses a dispute may be raised from: an insert that found anything else — an order
-- already DISPUTED, or a writer that moved the order first — is refused, never recorded wrong.
--
-- ## Disputes raised before this migration
--
-- Recorded only where the order's history says it of that dispute, by identity, not by time:
-- the dispute is the order's one OPEN dispute, the order is DISPUTED, and exactly one status
-- transition of the order was written by the transaction that inserted the dispute (the same
-- `xmin`) — the move into DISPUTED, from one of the four statuses. Both writers insert the
-- dispute and record that transition in one transaction, and an OPEN dispute row is never
-- updated, so its `xmin` is still its insert's. Timestamps decide nothing: a clock that went
-- back made the latest transition another dispute's (review of #625 round 1, R2). Every other
-- row keeps NULL — a resolved dispute needs no origin; an open one whose row was rewritten, or
-- whose transaction wrote no such transition or more than one, is refused SETTLE
-- (DISPUTE_ORIGIN_UNKNOWN) rather than resumed to a guess. REFUND stays open to it. A database
-- restored from a dump has new `xmin`s: per table they match nothing, and in one restore
-- transaction every row of an order shares one (a disputed order has at least two transitions),
-- so the count below refuses — NULL, never a guess. "The order's one OPEN dispute" is
-- `uq_dispute_one_open_per_order` (20260829185748), so it is that one by status, not by time.
--
-- ## Receipt evidence, from now on
--
-- `ck_order_receipt_confirmed_has_evidence`: a RECEIPT_CONFIRMED row names who confirmed
-- receipt and when, as SETTLING and COMPLETED already must (`ck_order_settled_after_receipt`).
-- NOT VALID: enforced on every write from now on, and not checked against existing rows — an
-- order the old SETTLE left RECEIPT_CONFIRMED without evidence is not repaired here, nor made
-- unreadable (docs/runbooks/marketplace-receipt-evidence.md finds them, read-only).
--
-- Bounded: one nullable column (no rewrite), one UPDATE of OPEN disputes only, joined through `ix_order_history_order`, one function, one trigger and
-- one NOT VALID constraint. Disputes are
-- a small fraction of orders; `statement_timeout` (default 5 s, raised for one run by
-- `RASTA_MIGRATION_STATEMENT_TIMEOUT`) fails the run with nothing changed rather than hold the
-- lock longer.
-- =============================================================================
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

ALTER TABLE "order_dispute" ADD COLUMN "raised_from_status" "OrderStatus";

ALTER TABLE "order_dispute" ADD CONSTRAINT "ck_order_dispute_raised_from"
  CHECK ("raised_from_status" IS NULL
         OR "raised_from_status" IN ('FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION',
                                     'RECEIPT_CONFIRMED'));

UPDATE "order_dispute" AS d
   SET "raised_from_status" = h."from_status"
  FROM "order" AS o, "order_status_history" AS h
 WHERE d."status" = 'OPEN'
   AND d."raised_from_status" IS NULL
   AND o."id" = d."order_id"
   AND o."status" = 'DISPUTED'
   -- Written by the transaction that inserted this dispute.
   AND h."order_id" = d."order_id"
   AND h."xmin" = d."xmin"
   AND h."kind" = 'TRANSITION'
   AND h."to_status" = 'DISPUTED'
   AND h."from_status" IN ('FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION',
                           'RECEIPT_CONFIRMED')
   -- And the only row of the order's history it wrote.
   AND (SELECT count(*) FROM "order_status_history" AS same
         WHERE same."order_id" = d."order_id" AND same."xmin" = d."xmin") = 1;

CREATE OR REPLACE FUNCTION assign_order_dispute_origin() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."raised_from_status" := (SELECT o."status" FROM "order" AS o WHERE o."id" = NEW."order_id");
  ELSE
    NEW."raised_from_status" := OLD."raised_from_status";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_order_dispute_origin"
  BEFORE INSERT OR UPDATE OF "raised_from_status" ON "order_dispute"
  FOR EACH ROW EXECUTE FUNCTION assign_order_dispute_origin();

ALTER TABLE "order" ADD CONSTRAINT "ck_order_receipt_confirmed_has_evidence"
  CHECK ("status" <> 'RECEIPT_CONFIRMED'
         OR ("receipt_confirmed_at" IS NOT NULL AND "receipt_confirmed_by" IS NOT NULL))
  NOT VALID;
