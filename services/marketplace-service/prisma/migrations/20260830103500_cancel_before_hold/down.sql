-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Restores the narrower constraint the initial migration carried. Reversing
-- this reintroduces the defect it fixed — a cancellation before the hold will
-- fail again — which is what reversing a bug fix means and is stated here so
-- nobody applies it expecting otherwise.
--
-- It cannot fail on existing data: the narrower predicate is stricter, so any
-- row written since the fix that relies on the wider one would refuse the
-- constraint. In practice that is a CANCELLING or CANCELLED order with no
-- transaction id, and this script leaves those rows for an operator rather than
-- deleting them — dropping an order to satisfy a constraint would be losing a
-- record to make a schema fit.
-- =============================================================================

ALTER TABLE "order" DROP CONSTRAINT "ck_order_held_has_transaction";

ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_held_has_transaction"
  CHECK (
    "status" IN ('PENDING', 'FAILED')
    OR "economic_transaction_id" IS NOT NULL
  );

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260830103500_cancel_before_hold';
