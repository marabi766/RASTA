-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Restores the narrower constraint the initial migration carried. Reversing
-- this reintroduces the defect it fixed — a cancellation before the hold will
-- be refused again — which is what reversing a bug fix means, and is stated
-- here so nobody applies it expecting otherwise.
--
-- ## Why the restored constraint is `NOT VALID`
--
-- By the time anyone rolls this back, the database can already hold rows only
-- the widened rule permits: a `CANCELLING` or `CANCELLED` order with no
-- `economic_transaction_id`, written by a buyer who cancelled before the saga
-- created the obligation. Those rows are correct. They are what the forward
-- migration existed to allow.
--
-- A plain `ADD CONSTRAINT ... CHECK` validates every existing row, so on such
-- a database it would **fail**, and the rollback would abort part-applied.
-- The three ways to make a plain constraint succeed are all worse than the
-- problem: deleting those orders destroys a record of something that happened,
-- filling in a transaction id invents a financial reference to an obligation
-- that was never created, and moving them to another status falsifies the
-- history of an order the buyer can see.
--
-- `NOT VALID` is the honest option, and its semantics are exactly what a
-- rollback needs:
--
--   * existing rows are **not** examined — nothing is deleted, altered or
--     invented, and a cancelled-before-hold order survives the rollback intact
--     and readable;
--   * every INSERT is checked, so the old rule is genuinely back in force for
--     new writes;
--   * every UPDATE is checked against the **new** row version, so a
--     pre-existing violating row cannot be edited into staying violating —
--     PostgreSQL applies the constraint to updates regardless of `NOT VALID`.
--
-- So this is not a weaker constraint going forward. It is the same constraint,
-- declared without a retroactive claim about data written while a different
-- rule was in force.
--
-- An operator who has reconciled the affected orders — by whatever means the
-- business decides, which is not a decision a migration gets to make — can
-- promote it to a fully checked constraint at any time:
--
--   ALTER TABLE "order" VALIDATE CONSTRAINT "ck_order_held_has_transaction";
--
-- That statement fails, naming the offending row, while any such order remains.
-- It is deliberately not run here: a rollback that succeeds or fails depending
-- on the data it happens to meet is not a rollback anybody can rely on.
--
-- To find the affected rows before deciding:
--
--   SELECT id, status, cancelled_at, cancellation_reason
--     FROM "order"
--    WHERE status IN ('CANCELLING', 'CANCELLED')
--      AND economic_transaction_id IS NULL;
-- =============================================================================

ALTER TABLE "order" DROP CONSTRAINT "ck_order_held_has_transaction";

ALTER TABLE "order"
  ADD CONSTRAINT "ck_order_held_has_transaction"
  CHECK (
    "status" IN ('PENDING', 'FAILED')
    OR "economic_transaction_id" IS NOT NULL
  )
  NOT VALID;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260830103500_cancel_before_hold';
