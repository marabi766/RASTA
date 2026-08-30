-- =============================================================================
-- `ck_order_held_has_transaction` contradicted the state machine.
--
-- The constraint said: any status other than PENDING or FAILED must name an
-- economic transaction. The intent was right — money is only held once there is
-- an obligation to hold it against — but the list of exempt states was
-- incomplete.
--
-- ADR-038 permits `PENDING → CANCELLING`: a buyer may cancel before the saga
-- has created the obligation, and at that moment there is no transaction to
-- name. `CANCELLING → CANCELLED` then inherits the same nullable id. The
-- constraint refused both, so a cancellation before the hold failed with a
-- driver error the caller saw as `500`.
--
-- Found by the order API suite, which cancels a PENDING order. The end-to-end
-- suite never reached it: there, cancellation always follows FUNDS_HELD, so the
-- transaction id was always present.
--
-- The rule this restores, stated fully: money is held only in the states
-- between the obligation being created and the order closing. An order that
-- never got that far, or that ended without one, may have no transaction id.
-- =============================================================================

ALTER TABLE "order" DROP CONSTRAINT "ck_order_held_has_transaction";

ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_held_has_transaction"
  CHECK (
    "status" IN ('PENDING', 'FAILED', 'CANCELLING', 'CANCELLED')
    OR "economic_transaction_id" IS NOT NULL
  );
