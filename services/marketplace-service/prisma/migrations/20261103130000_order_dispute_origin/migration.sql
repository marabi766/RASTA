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
-- Recorded only where the order's history says it without doubt: the dispute is the order's one
-- OPEN dispute, the order is DISPUTED, and the order's latest status transition (one row, no
-- other at its instant) is the move into DISPUTED, from one of the four statuses. That row was
-- written with the dispute, in the same transaction; nothing leaves DISPUTED but a resolution,
-- which closes the dispute. Every other row keeps NULL: a resolved dispute needs no origin, and an
-- open one whose history is not that clear is refused SETTLE (DISPUTE_ORIGIN_UNKNOWN) rather
-- than resumed to a guess. REFUND stays open to it.
--
-- ## Receipt evidence, from now on
--
-- `ck_order_receipt_confirmed_has_evidence`: a RECEIPT_CONFIRMED row names who confirmed
-- receipt and when, as SETTLING and COMPLETED already must (`ck_order_settled_after_receipt`).
-- NOT VALID: enforced on every write from now on, and not checked against existing rows — an
-- order the old SETTLE left RECEIPT_CONFIRMED without evidence is not repaired here, nor made
-- unreadable (docs/runbooks/marketplace-receipt-evidence.md finds them, read-only).
--
-- Bounded: one nullable column (no rewrite), one UPDATE of OPEN disputes only, joined through
-- `ix_order_history_order`, one function, one trigger and one NOT VALID constraint. Disputes are
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
  FROM "order" AS o,
       LATERAL (
         SELECT "from_status", "to_status", "occurred_at"
           FROM "order_status_history"
          WHERE "order_id" = o."id" AND "kind" = 'TRANSITION'
          ORDER BY "occurred_at" DESC
          LIMIT 1
       ) AS h
 WHERE d."status" = 'OPEN'
   AND d."raised_from_status" IS NULL
   AND o."id" = d."order_id"
   AND o."status" = 'DISPUTED'
   AND h."to_status" = 'DISPUTED'
   AND h."from_status" IN ('FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION',
                           'RECEIPT_CONFIRMED')
   -- One transition at that instant, or which one was the move is not certain.
   AND (SELECT count(*) FROM "order_status_history" AS same
         WHERE same."order_id" = o."id" AND same."kind" = 'TRANSITION'
           AND same."occurred_at" = h."occurred_at") = 1
   -- The order's only open dispute.
   AND NOT EXISTS (SELECT 1 FROM "order_dispute" AS other
                    WHERE other."order_id" = d."order_id" AND other."status" = 'OPEN'
                      AND other."id" <> d."id");

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
